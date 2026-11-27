import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

/**
 * Nomes dos botões da barra de tarefas do Windows que contêm `needle` (só esses são lidos e
 * devolvidos). null = sem barra de tarefas acessível (fora do Windows ou sem sessão gráfica).
 * A primeira consulta de UI Automation de um processo novo volta vazia: consulta duas vezes.
 */
export async function taskbarButtons(needle: string): Promise<string[] | null> {
  if (process.platform !== 'win32') return null
  const script = [
    '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
    'Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes',
    '$needle = [Environment]::GetEnvironmentVariable("FACET_TASKBAR_NEEDLE")',
    'function Buttons {',
    '  $root = [System.Windows.Automation.AutomationElement]::RootElement',
    '  $tray = $root.FindFirst([System.Windows.Automation.TreeScope]::Children, (New-Object System.Windows.Automation.PropertyCondition ([System.Windows.Automation.AutomationElement]::ClassNameProperty, "Shell_TrayWnd")))',
    '  if (-not $tray) { return $null }',
    '  $tray.FindAll([System.Windows.Automation.TreeScope]::Descendants, (New-Object System.Windows.Automation.PropertyCondition ([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::Button)))',
    '}',
    '$null = Buttons',
    'Start-Sleep -Milliseconds 700',
    '$all = Buttons',
    'if ($null -eq $all) { "NO_TRAY"; exit }',
    '$names = @($all | ForEach-Object { $_.Current.Name } | Where-Object { $_ -and $_.Contains($needle) })',
    'ConvertTo-Json -Compress -InputObject $names',
  ].join('\n')
  const { stdout } = await execFileAsync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', script],
    {
      windowsHide: true,
      timeout: 30000,
      env: { ...process.env, FACET_TASKBAR_NEEDLE: needle },
    },
  )
  const text = stdout.trim()
  if (text === 'NO_TRAY') return null
  if (!text) return []
  const parsed: unknown = JSON.parse(text)
  return Array.isArray(parsed) ? parsed.map(String) : [String(parsed)]
}
