// Facet: utilitário nativo do Windows. Compilado com o csc do .NET Framework (C# 5).
//
// Modo padrão: identificação das janelas dos perfis na barra de tarefas.
// Recebe comandos pela entrada padrão (UTF-8, um por linha, campos separados por TAB):
//   track   <pid> <appUserModelId> <icone.ico> <nome> <comando>
//   rename  <pid> <nome>
//   untrack <pid>
// e marca as janelas desses processos no instante em que o Windows as cria (antes de aparecerem
// na barra de tarefas): AppUserModelID próprio (botão separado na barra de tarefas), ícone e nome
// de reabertura, fixação bloqueada e ícone da janela (Alt+Tab). Uma varredura a cada segundo
// cobre o que escapar e remarca a janela cujo AppUserModelID tenha sido trocado.
// Responde "tagged <pid> <janelas>" e "error <mensagem>".
//
// Modo --processes: consultas de processos, sem o PowerShell (que leva segundos para iniciar).
//   list <id> <pid>   um processo
//   list <id> *       todos cuja linha de comando tem --user-data-dir=
// Responde "ok <id> <json>" (lista de {ProcessId, ExecutablePath, CommandLine, Started}, como o
// Get-CimInstance Win32_Process) ou "error <id> <mensagem>".
//
// Nos dois modos, termina quando a entrada fecha (o Facet saiu).
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

[ComImport, Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IPropertyStore {
  [PreserveSig] int GetCount(out uint count);
  [PreserveSig] int GetAt(uint index, out PropertyKey key);
  [PreserveSig] int GetValue(ref PropertyKey key, out PropVariant value);
  [PreserveSig] int SetValue(ref PropertyKey key, ref PropVariant value);
  [PreserveSig] int Commit();
}

[StructLayout(LayoutKind.Sequential, Pack = 4)]
struct PropertyKey {
  public Guid FormatId;
  public uint PropertyId;
}

// PROPVARIANT tem 24 bytes em 64 bits: o GetValue escreve todos (com 16, sobrescreveria a pilha).
[StructLayout(LayoutKind.Explicit, Size = 24)]
struct PropVariant {
  [FieldOffset(0)] public ushort Type;
  [FieldOffset(8)] public IntPtr Pointer;
  [FieldOffset(8)] public short Bool;
}

[StructLayout(LayoutKind.Sequential)]
struct Message {
  public IntPtr Window;
  public uint Id;
  public IntPtr WParam;
  public IntPtr LParam;
  public uint Time;
  public int X;
  public int Y;
}

static class Program {
  [STAThread]
  static int Main(string[] args) {
    if (args.Length > 0 && args[0] == "--processes") return Processes.Run();
    return Taskbar.Run();
  }
}

static class Output {
  static readonly StreamWriter Writer = new StreamWriter(Console.OpenStandardOutput(), new UTF8Encoding(false));
  static readonly object Gate = new object();

  public static void Write(string kind, string text) {
    lock (Gate) {
      try {
        Writer.WriteLine(kind + "\t" + text.Replace('\n', ' ').Replace('\r', ' '));
        Writer.Flush();
      } catch (IOException) {
        // o Facet fechou a saída: nada a fazer
      } catch (ObjectDisposedException) {
      }
    }
  }
}

static class Taskbar {
  sealed class Target {
    public uint Pid;
    public string AppId;
    public string Icon;
    public string Name;
    public string Command;
    public IntPtr BigIcon;
    public IntPtr SmallIcon;
    public readonly HashSet<IntPtr> Tagged = new HashSet<IntPtr>();
  }

  delegate bool EnumWindowsProc(IntPtr window, IntPtr parameter);
  delegate void WinEventProc(IntPtr hook, uint eventType, IntPtr window, int objectId, int childId, uint thread, uint time);

  [DllImport("user32.dll")] static extern bool EnumWindows(EnumWindowsProc callback, IntPtr parameter);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr window, out uint processId);
  [DllImport("user32.dll")] static extern bool IsWindow(IntPtr window);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr window);
  [DllImport("user32.dll")] static extern IntPtr GetWindow(IntPtr window, uint command);
  [DllImport("user32.dll")] static extern IntPtr GetAncestor(IntPtr window, uint flags);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr window, StringBuilder name, int size);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern IntPtr LoadImage(IntPtr instance, string name, uint type, int width, int height, uint flags);
  [DllImport("user32.dll")] static extern bool DestroyIcon(IntPtr icon);
  [DllImport("user32.dll")] static extern bool PostMessage(IntPtr window, uint message, IntPtr wParam, IntPtr lParam);
  [DllImport("user32.dll")] static extern bool PostThreadMessage(uint thread, uint message, IntPtr wParam, IntPtr lParam);
  [DllImport("user32.dll")] static extern int GetMessage(out Message message, IntPtr window, uint min, uint max);
  [DllImport("user32.dll")] static extern bool TranslateMessage(ref Message message);
  [DllImport("user32.dll")] static extern IntPtr DispatchMessage(ref Message message);
  [DllImport("user32.dll")] static extern IntPtr SetTimer(IntPtr window, IntPtr id, uint elapse, IntPtr callback);
  [DllImport("user32.dll")] static extern IntPtr SetWinEventHook(uint min, uint max, IntPtr module, WinEventProc callback, uint process, uint thread, uint flags);
  [DllImport("user32.dll")] static extern bool UnhookWinEvent(IntPtr hook);
  [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
  [DllImport("shell32.dll")] static extern int SHGetPropertyStoreForWindow(IntPtr window, ref Guid iid, [MarshalAs(UnmanagedType.Interface)] out IPropertyStore store);
  [DllImport("ole32.dll")] static extern int PropVariantClear(ref PropVariant value);

  static readonly Guid AppUserModel = new Guid("9F4C2855-9F79-4B39-A8D0-E1D42DE1D5F3");
  const uint RelaunchCommand = 2;
  const uint RelaunchIconResource = 3;
  const uint RelaunchDisplayName = 4;
  const uint AppId = 5;
  const uint PreventPinning = 9;
  const uint GW_OWNER = 4;
  const uint GA_ROOT = 2;
  const uint WM_SETICON = 0x80;
  const uint WM_TIMER = 0x113;
  const uint WM_APP = 0x8000;
  const uint IMAGE_ICON = 1;
  const uint LR_LOADFROMFILE = 0x10;
  const uint EVENT_OBJECT_CREATE = 0x8000;
  const uint EVENT_OBJECT_SHOW = 0x8002;
  const uint WINEVENT_SKIPOWNPROCESS = 2;
  const int OBJID_WINDOW = 0;
  const int CHILDID_SELF = 0;

  static readonly Dictionary<uint, Target> Targets = new Dictionary<uint, Target>();
  static readonly Queue<string[]> Commands = new Queue<string[]>();
  static readonly object Gate = new object();
  static volatile bool InputClosed;
  static uint MainThread;
  // referência mantida: o coletor de lixo não pode liberar o delegate usado pelo Windows
  static WinEventProc EventCallback;

  public static int Run() {
    MainThread = GetCurrentThreadId();
    EventCallback = OnWinEvent;
    // Fora do contexto (sem DLL no navegador): o Windows entrega os eventos na fila desta thread.
    IntPtr hook = SetWinEventHook(EVENT_OBJECT_CREATE, EVENT_OBJECT_SHOW, IntPtr.Zero, EventCallback, 0, 0, WINEVENT_SKIPOWNPROCESS);
    if (hook == IntPtr.Zero) Output.Write("error", "SetWinEventHook falhou; só a varredura periódica marca as janelas");
    SetTimer(IntPtr.Zero, IntPtr.Zero, 1000, IntPtr.Zero);
    Thread reader = new Thread(ReadInput);
    reader.IsBackground = true;
    reader.Start();
    Message message;
    while (GetMessage(out message, IntPtr.Zero, 0, 0) > 0) {
      if (message.Window == IntPtr.Zero && message.Id == WM_APP) {
        bool changed = ProcessCommands();
        if (InputClosed && !HasCommands()) break;
        Scan(changed);
      } else if (message.Window == IntPtr.Zero && message.Id == WM_TIMER) {
        Scan(false);
      } else {
        TranslateMessage(ref message);
        DispatchMessage(ref message);
      }
    }
    if (hook != IntPtr.Zero) UnhookWinEvent(hook);
    foreach (Target target in Targets.Values) ReleaseIcons(target);
    return 0;
  }

  static void ReadInput() {
    StreamReader input = new StreamReader(Console.OpenStandardInput(), new UTF8Encoding(false));
    string line;
    while ((line = input.ReadLine()) != null) {
      lock (Gate) Commands.Enqueue(line.Split('\t'));
      PostThreadMessage(MainThread, WM_APP, IntPtr.Zero, IntPtr.Zero);
    }
    InputClosed = true;
    PostThreadMessage(MainThread, WM_APP, IntPtr.Zero, IntPtr.Zero);
  }

  static bool HasCommands() {
    lock (Gate) return Commands.Count > 0;
  }

  static bool ProcessCommands() {
    bool changed = false;
    while (true) {
      string[] fields;
      lock (Gate) {
        if (Commands.Count == 0) return changed;
        fields = Commands.Dequeue();
      }
      try {
        changed |= Execute(fields);
      } catch (Exception error) {
        Output.Write("error", error.Message);
      }
    }
  }

  static bool Execute(string[] fields) {
    uint pid;
    if (fields.Length < 2 || !uint.TryParse(fields[1], out pid)) return false;
    Target target;
    switch (fields[0]) {
      case "track":
        if (fields.Length != 6) return false;
        if (Targets.TryGetValue(pid, out target)) ReleaseIcons(target);
        target = new Target();
        target.Pid = pid;
        target.AppId = fields[2];
        target.Icon = fields[3];
        target.Name = fields[4];
        target.Command = fields[5];
        Targets[pid] = target;
        return true;
      case "rename":
        if (fields.Length != 3 || !Targets.TryGetValue(pid, out target)) return false;
        target.Name = fields[2];
        target.Tagged.Clear();
        return true;
      case "untrack":
        if (Targets.TryGetValue(pid, out target)) {
          ReleaseIcons(target);
          Targets.Remove(pid);
        }
        return false;
    }
    return false;
  }

  /** Janela principal do Chromium: classe própria, sem dona e de nível superior. */
  static bool IsBrowserWindow(IntPtr window) {
    if (GetWindow(window, GW_OWNER) != IntPtr.Zero || GetAncestor(window, GA_ROOT) != window) return false;
    StringBuilder name = new StringBuilder(64);
    GetClassName(window, name, name.Capacity);
    return name.ToString() == "Chrome_WidgetWin_1";
  }

  /**
   * Janela criada: recebe a identidade antes de aparecer, então o botão da barra de tarefas já
   * nasce com o ícone do perfil. Janela exibida: confere de novo (o navegador pode ter trocado).
   */
  static void OnWinEvent(IntPtr hook, uint eventType, IntPtr window, int objectId, int childId, uint thread, uint time) {
    if (objectId != OBJID_WINDOW || childId != CHILDID_SELF || window == IntPtr.Zero || Targets.Count == 0) return;
    try {
      uint pid;
      GetWindowThreadProcessId(window, out pid);
      Target target;
      if (!Targets.TryGetValue(pid, out target) || !IsBrowserWindow(window)) return;
      if (eventType == EVENT_OBJECT_CREATE) {
        Tag(window, target);
      } else if (eventType == EVENT_OBJECT_SHOW) {
        if (target.Tagged.Contains(window) && HasIdentity(window, target)) return;
        if (Tag(window, target)) {
          target.Tagged.Add(window);
          Output.Write("tagged", pid + "\t1");
        }
      }
    } catch (Exception error) {
      Output.Write("error", error.Message);
    }
  }

  static void Scan(bool force) {
    if (Targets.Count == 0) return;
    List<IntPtr> windows = new List<IntPtr>();
    EnumWindows(delegate (IntPtr window, IntPtr parameter) {
      if (!IsWindowVisible(window) || GetWindow(window, GW_OWNER) != IntPtr.Zero) return true;
      StringBuilder name = new StringBuilder(64);
      GetClassName(window, name, name.Capacity);
      if (name.ToString() == "Chrome_WidgetWin_1") windows.Add(window);
      return true;
    }, IntPtr.Zero);
    Dictionary<uint, int> tagged = new Dictionary<uint, int>();
    foreach (IntPtr window in windows) {
      uint pid;
      GetWindowThreadProcessId(window, out pid);
      Target target;
      if (!Targets.TryGetValue(pid, out target)) continue;
      // marcada e com a identidade intacta: nada a fazer
      if (target.Tagged.Contains(window) && HasIdentity(window, target)) continue;
      try {
        if (Tag(window, target)) {
          target.Tagged.Add(window);
          int count;
          tagged.TryGetValue(pid, out count);
          tagged[pid] = count + 1;
        }
      } catch (Exception error) {
        Output.Write("error", error.Message);
      }
    }
    foreach (Target target in Targets.Values) target.Tagged.RemoveWhere(window => !IsWindow(window));
    foreach (KeyValuePair<uint, int> entry in tagged) Output.Write("tagged", entry.Key + "\t" + entry.Value);
  }

  /** O AppUserModelID da janela ainda é o do perfil. */
  static bool HasIdentity(IntPtr window, Target target) {
    Guid iid = typeof(IPropertyStore).GUID;
    IPropertyStore store;
    if (SHGetPropertyStoreForWindow(window, ref iid, out store) != 0) return false;
    try {
      PropertyKey key = new PropertyKey();
      key.FormatId = AppUserModel;
      key.PropertyId = AppId;
      PropVariant value;
      if (store.GetValue(ref key, out value) != 0) return false;
      try {
        return value.Type == 31 && Marshal.PtrToStringUni(value.Pointer) == target.AppId;
      } finally {
        PropVariantClear(ref value);
      }
    } finally {
      Marshal.ReleaseComObject(store);
    }
  }

  static bool Tag(IntPtr window, Target target) {
    Guid iid = typeof(IPropertyStore).GUID;
    IPropertyStore store;
    if (SHGetPropertyStoreForWindow(window, ref iid, out store) != 0) return false;
    try {
      SetString(store, AppId, target.AppId);
      SetString(store, RelaunchIconResource, target.Icon + ",0");
      SetString(store, RelaunchCommand, target.Command);
      SetString(store, RelaunchDisplayName, target.Name);
      PropertyKey key = new PropertyKey();
      key.FormatId = AppUserModel;
      key.PropertyId = PreventPinning;
      PropVariant value = new PropVariant();
      value.Type = 11; // VT_BOOL
      value.Bool = -1;
      store.SetValue(ref key, ref value);
      store.Commit();
    } finally {
      Marshal.ReleaseComObject(store);
    }
    if (target.BigIcon == IntPtr.Zero) target.BigIcon = LoadImage(IntPtr.Zero, target.Icon, IMAGE_ICON, 32, 32, LR_LOADFROMFILE);
    if (target.SmallIcon == IntPtr.Zero) target.SmallIcon = LoadImage(IntPtr.Zero, target.Icon, IMAGE_ICON, 16, 16, LR_LOADFROMFILE);
    // Postado (não enviado): a janela recém-criada ainda não processa mensagens, e esperar por ela
    // atrasaria a marcação das outras.
    if (target.BigIcon != IntPtr.Zero) PostMessage(window, WM_SETICON, (IntPtr)1, target.BigIcon);
    if (target.SmallIcon != IntPtr.Zero) PostMessage(window, WM_SETICON, IntPtr.Zero, target.SmallIcon);
    return true;
  }

  static void SetString(IPropertyStore store, uint id, string text) {
    PropertyKey key = new PropertyKey();
    key.FormatId = AppUserModel;
    key.PropertyId = id;
    PropVariant value = new PropVariant();
    value.Type = 31; // VT_LPWSTR
    value.Pointer = Marshal.StringToCoTaskMemUni(text);
    try {
      int result = store.SetValue(ref key, ref value);
      if (result != 0) throw new InvalidOperationException("SetValue " + id + " = 0x" + result.ToString("X8"));
    } finally {
      PropVariantClear(ref value);
    }
  }

  static void ReleaseIcons(Target target) {
    if (target.BigIcon != IntPtr.Zero) DestroyIcon(target.BigIcon);
    if (target.SmallIcon != IntPtr.Zero) DestroyIcon(target.SmallIcon);
    target.BigIcon = IntPtr.Zero;
    target.SmallIcon = IntPtr.Zero;
  }
}

static class Processes {
  [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool QueryFullProcessImageName(IntPtr process, uint flags, StringBuilder name, ref uint size);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool GetProcessTimes(IntPtr process, out long creation, out long exit, out long kernel, out long user);
  [DllImport("ntdll.dll")] static extern int NtQueryInformationProcess(IntPtr process, int infoClass, IntPtr info, int length, out int returnLength);

  const uint PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
  const int ProcessCommandLineInformation = 60;

  public static int Run() {
    StreamReader input = new StreamReader(Console.OpenStandardInput(), new UTF8Encoding(false));
    string line;
    while ((line = input.ReadLine()) != null) {
      string[] fields = line.Split('\t');
      if (fields.Length != 3 || fields[0] != "list") continue;
      string id = fields[1];
      try {
        Output.Write("ok", id + "\t" + List(fields[2]));
      } catch (Exception error) {
        Output.Write("error", id + "\t" + error.Message);
      }
    }
    return 0;
  }

  static string List(string which) {
    StringBuilder json = new StringBuilder("[");
    bool first = true;
    if (which == "*") {
      foreach (Process process in Process.GetProcesses()) {
        uint pid = (uint)process.Id;
        process.Dispose();
        string row = Describe(pid, true);
        if (row == null) continue;
        if (!first) json.Append(',');
        json.Append(row);
        first = false;
      }
    } else {
      uint pid;
      if (!uint.TryParse(which, NumberStyles.None, CultureInfo.InvariantCulture, out pid)) throw new ArgumentException("pid inválido");
      string row = Describe(pid, false);
      if (row != null) json.Append(row);
    }
    return json.Append(']').ToString();
  }

  /** null = processo inacessível, encerrado ou (na lista) sem --user-data-dir=. */
  static string Describe(uint pid, bool onlyProfiles) {
    if (pid == 0) return null;
    IntPtr handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid);
    if (handle == IntPtr.Zero) return null;
    try {
      string command = CommandLine(handle);
      if (command == null) return null;
      if (onlyProfiles && command.IndexOf("--user-data-dir=", StringComparison.OrdinalIgnoreCase) < 0) return null;
      StringBuilder path = new StringBuilder(32768);
      uint size = (uint)path.Capacity;
      if (!QueryFullProcessImageName(handle, 0, path, ref size)) return null;
      long creation, exit, kernel, user;
      if (!GetProcessTimes(handle, out creation, out exit, out kernel, out user)) return null;
      // Mesmo texto do CreationDate do WMI (microssegundos) em UTC, formato ISO "o".
      long ticks = DateTime.FromFileTimeUtc(creation).Ticks;
      string started = new DateTime(ticks - ticks % 10, DateTimeKind.Utc).ToString("o", CultureInfo.InvariantCulture);
      return "{\"ProcessId\":" + pid.ToString(CultureInfo.InvariantCulture) +
        ",\"ExecutablePath\":" + Quote(path.ToString(0, (int)size)) +
        ",\"CommandLine\":" + Quote(command) +
        ",\"Started\":" + Quote(started) + "}";
    } finally {
      CloseHandle(handle);
    }
  }

  /** Linha de comando de outro processo (Windows 8.1+, só com acesso limitado de consulta). */
  static string CommandLine(IntPtr handle) {
    int length;
    NtQueryInformationProcess(handle, ProcessCommandLineInformation, IntPtr.Zero, 0, out length);
    if (length <= 0 || length > 1 << 20) return null;
    IntPtr buffer = Marshal.AllocHGlobal(length);
    try {
      if (NtQueryInformationProcess(handle, ProcessCommandLineInformation, buffer, length, out length) != 0) return null;
      // UNICODE_STRING: Length (bytes), MaximumLength e o ponteiro (alinhado ao tamanho do ponteiro)
      int bytes = (ushort)Marshal.ReadInt16(buffer, 0);
      IntPtr text = Marshal.ReadIntPtr(buffer, IntPtr.Size);
      if (text == IntPtr.Zero) return bytes == 0 ? "" : null;
      return Marshal.PtrToStringUni(text, bytes / 2);
    } finally {
      Marshal.FreeHGlobal(buffer);
    }
  }

  static string Quote(string text) {
    StringBuilder result = new StringBuilder(text.Length + 2);
    result.Append('"');
    foreach (char c in text) {
      switch (c) {
        case '"': result.Append("\\\""); break;
        case '\\': result.Append("\\\\"); break;
        case '\n': result.Append("\\n"); break;
        case '\r': result.Append("\\r"); break;
        case '\t': result.Append("\\t"); break;
        default:
          if (c < 0x20) result.Append("\\u").Append(((int)c).ToString("x4", CultureInfo.InvariantCulture));
          else result.Append(c);
          break;
      }
    }
    return result.Append('"').ToString();
  }
}
