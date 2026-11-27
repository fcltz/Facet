import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

/**
 * Barras de aviso (infobars) visíveis nas janelas do processo `pid`, lidas por UI Automation:
 * "classe: texto" de cada elemento cuja classe tem "InfoBar" e do texto do flag de automação.
 * Vazio = nenhuma barra. null = fora do Windows ou sem janela acessível.
 * A primeira consulta de UI Automation de um processo novo volta vazia: consulta duas vezes.
 */
export async function browserInfobars(pid: number): Promise<string[] | null> {
  if (process.platform !== 'win32') return null
  const script = [
    '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
    'Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes',
    '$target = [int][Environment]::GetEnvironmentVariable("FACET_INFOBAR_PID")',
    'function Windows {',
    '  $root = [System.Windows.Automation.AutomationElement]::RootElement',
    '  $root.FindAll([System.Windows.Automation.TreeScope]::Children, (New-Object System.Windows.Automation.PropertyCondition ([System.Windows.Automation.AutomationElement]::ProcessIdProperty, $target)))',
    '}',
    '$null = Windows',
    'Start-Sleep -Milliseconds 500',
    '$windows = @(Windows)',
    'if ($windows.Count -eq 0) { "NO_WINDOW"; exit }',
    '$bars = @(foreach ($window in $windows) {',
    '  $window.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition) | Where-Object {',
    '    ($_.Current.ClassName -and $_.Current.ClassName.Contains("InfoBar")) -or ($_.Current.Name -and $_.Current.Name.Contains("disable-blink-features"))',
    '  } | ForEach-Object { $_.Current.ClassName + ": " + $_.Current.Name }',
    '})',
    'ConvertTo-Json -Compress -InputObject $bars',
  ].join('\n')
  const { stdout } = await execFileAsync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', script],
    {
      windowsHide: true,
      timeout: 30000,
      env: { ...process.env, FACET_INFOBAR_PID: String(pid) },
    },
  )
  const text = stdout.trim()
  if (text === 'NO_WINDOW') return null
  if (!text) return []
  const parsed: unknown = JSON.parse(text)
  return Array.isArray(parsed) ? parsed.map(String) : [String(parsed)]
}
