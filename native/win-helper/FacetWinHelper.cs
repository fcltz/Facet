// Facet: identificação das janelas dos perfis na barra de tarefas do Windows.
//
// Recebe comandos pela entrada padrão (UTF-8, um por linha, campos separados por TAB):
//   track   <pid> <appUserModelId> <icone.ico> <nome> <comando>
//   rename  <pid> <nome>
//   untrack <pid>
// e, a cada segundo, marca as janelas novas desses processos: AppUserModelID próprio (botão
// separado na barra de tarefas), ícone e nome de reabertura, fixação bloqueada e ícone da
// janela (Alt+Tab). Responde "tagged <pid> <janelas>" e "error <mensagem>".
// Termina quando a entrada fecha (o Facet saiu). Compilado com o csc do .NET Framework (C# 5).
using System;
using System.Collections.Generic;
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

[StructLayout(LayoutKind.Explicit)]
struct PropVariant {
  [FieldOffset(0)] public ushort Type;
  [FieldOffset(8)] public IntPtr Pointer;
  [FieldOffset(8)] public short Bool;
}

static class Program {
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

  [DllImport("user32.dll")] static extern bool EnumWindows(EnumWindowsProc callback, IntPtr parameter);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr window, out uint processId);
  [DllImport("user32.dll")] static extern bool IsWindow(IntPtr window);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr window);
  [DllImport("user32.dll")] static extern IntPtr GetWindow(IntPtr window, uint command);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr window, StringBuilder name, int size);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern IntPtr LoadImage(IntPtr instance, string name, uint type, int width, int height, uint flags);
  [DllImport("user32.dll")] static extern bool DestroyIcon(IntPtr icon);
  [DllImport("user32.dll")] static extern IntPtr SendMessageTimeout(IntPtr window, uint message, IntPtr wParam, IntPtr lParam, uint flags, uint timeout, out IntPtr result);
  [DllImport("shell32.dll")] static extern int SHGetPropertyStoreForWindow(IntPtr window, ref Guid iid, [MarshalAs(UnmanagedType.Interface)] out IPropertyStore store);
  [DllImport("ole32.dll")] static extern int PropVariantClear(ref PropVariant value);

  static readonly Guid AppUserModel = new Guid("9F4C2855-9F79-4B39-A8D0-E1D42DE1D5F3");
  const uint RelaunchCommand = 2;
  const uint RelaunchIconResource = 3;
  const uint RelaunchDisplayName = 4;
  const uint AppId = 5;
  const uint PreventPinning = 9;
  const uint GW_OWNER = 4;
  const uint WM_SETICON = 0x80;
  const uint SMTO_ABORTIFHUNG = 2;
  const uint IMAGE_ICON = 1;
  const uint LR_LOADFROMFILE = 0x10;

  static readonly Dictionary<uint, Target> Targets = new Dictionary<uint, Target>();
  static readonly Queue<string[]> Commands = new Queue<string[]>();
  static readonly object Gate = new object();
  static readonly AutoResetEvent Wake = new AutoResetEvent(false);
  static volatile bool InputClosed;
  static StreamWriter Output;

  [STAThread]
  static void Main() {
    Output = new StreamWriter(Console.OpenStandardOutput(), new UTF8Encoding(false));
    Output.AutoFlush = true;
    Thread reader = new Thread(ReadInput);
    reader.IsBackground = true;
    reader.Start();
    while (true) {
      bool changed = ProcessCommands();
      if (InputClosed && !HasCommands()) break;
      Scan(changed);
      Wake.WaitOne(1000);
    }
    foreach (Target target in Targets.Values) ReleaseIcons(target);
  }

  static void ReadInput() {
    StreamReader input = new StreamReader(Console.OpenStandardInput(), new UTF8Encoding(false));
    string line;
    while ((line = input.ReadLine()) != null) {
      lock (Gate) Commands.Enqueue(line.Split('\t'));
      Wake.Set();
    }
    InputClosed = true;
    Wake.Set();
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
        Write("error", error.Message);
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
      if (!Targets.TryGetValue(pid, out target) || target.Tagged.Contains(window)) continue;
      try {
        if (Tag(window, target)) {
          target.Tagged.Add(window);
          int count;
          tagged.TryGetValue(pid, out count);
          tagged[pid] = count + 1;
        }
      } catch (Exception error) {
        Write("error", error.Message);
      }
    }
    foreach (Target target in Targets.Values) target.Tagged.RemoveWhere(window => !IsWindow(window));
    foreach (KeyValuePair<uint, int> entry in tagged) Write("tagged", entry.Key + "\t" + entry.Value);
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
    IntPtr ignored;
    if (target.BigIcon != IntPtr.Zero) SendMessageTimeout(window, WM_SETICON, (IntPtr)1, target.BigIcon, SMTO_ABORTIFHUNG, 500, out ignored);
    if (target.SmallIcon != IntPtr.Zero) SendMessageTimeout(window, WM_SETICON, IntPtr.Zero, target.SmallIcon, SMTO_ABORTIFHUNG, 500, out ignored);
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

  static void Write(string kind, string text) {
    try {
      Output.WriteLine(kind + "\t" + text.Replace('\n', ' ').Replace('\r', ' '));
    } catch (IOException) {
      // o Facet fechou a saída: nada a fazer
    }
  }
}
