using System;
using System.IO;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;

// All content stays buffered until every handle has been checked again.
// Handles deny DELETE sharing; file handles also deny WRITE sharing. Never
// fall back to path-based reads when a lock or a final-path check fails.
public static class TaskBridgeWindowsReader {
    [StructLayout(LayoutKind.Sequential)] struct Info {
        public uint attributes; public System.Runtime.InteropServices.ComTypes.FILETIME creation, access, write;
        public uint volume, sizeHigh, sizeLow, links, indexHigh, indexLow;
    }
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
    static extern SafeFileHandle CreateFile(string name, uint access, uint share, IntPtr security, uint disposition, uint flags, IntPtr template);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
    static extern uint GetFinalPathNameByHandle(SafeFileHandle handle, StringBuilder name, uint length, uint flags);
    [DllImport("kernel32.dll", SetLastError=true)]
    static extern bool GetFileInformationByHandle(SafeFileHandle handle, out Info info);
    const uint Reparse = 0x400, Directory = 0x10;
    static Exception Deny() { return new IOException("FILE_FORBIDDEN"); }
    static string Final(SafeFileHandle handle) {
        var text = new StringBuilder(32768);
        uint size = GetFinalPathNameByHandle(handle, text, (uint)text.Capacity, 0);
        if (size == 0 || size >= text.Capacity) throw Deny();
        string value = text.ToString();
        if (!value.StartsWith(@"\\?\") || value.StartsWith(@"\\?\UNC\", StringComparison.OrdinalIgnoreCase)) throw Deny();
        return value.Substring(4).TrimEnd('\\');
    }
    static Info Inspect(SafeFileHandle handle) {
        Info info;
        if (!GetFileInformationByHandle(handle, out info) || (info.attributes & Reparse) != 0) throw Deny();
        return info;
    }
    static SafeFileHandle Open(string target, bool directory) {
        var handle = CreateFile(target, directory ? 0x80u : 0x80000000u, directory ? 3u : 1u, IntPtr.Zero, 3, 0x00200000u | 0x02000000u, IntPtr.Zero);
        if (handle.IsInvalid) { handle.Dispose(); throw Deny(); }
        try {
            var info = Inspect(handle);
            if (((info.attributes & Directory) != 0) != directory || (!directory && info.links != 1)) throw Deny();
            if (!String.Equals(Final(handle), target.TrimEnd('\\'), StringComparison.OrdinalIgnoreCase)) throw Deny();
            return handle;
        } catch { handle.Dispose(); throw; }
    }
    static bool Private(string name) {
        return name.StartsWith(".") || System.Text.RegularExpressions.Regex.IsMatch(name, @"^(?:\.git|\.pi|\.ssh|\.aws|\.codex|node_modules|data|\.env(?:\..*)?|secrets?(?:\..*)?|credentials(?:\..*)?|config\.json|server-auth\.json|auth\.json)$|\.(?:pem|key|p12|pfx|jks|keystore)$", System.Text.RegularExpressions.RegexOptions.IgnoreCase);
    }
    public static object Execute(string root, string relative, string operation, int maxBytes, int offset, int limit) {
        var handles = new List<SafeFileHandle>();
        var names = new List<string>();
        try {
            if (maxBytes < 1 || maxBytes > 2097152 || offset < 0 || offset > 5000 || limit < 1 || limit > 200) throw Deny();
            root = Path.GetFullPath(root).TrimEnd('\\');
            if (root.Length < 4 || root[1] != ':' || root.StartsWith(@"\\")) throw Deny();
            string combined = root;
            if (!String.IsNullOrEmpty(relative)) {
                foreach (string part in relative.Split('/')) {
                    if (part.Length == 0 || part == "." || part == ".." || Private(part) || part.IndexOfAny(new char[]{'\\', ':', '\0'}) >= 0) throw Deny();
                }
                combined += "\\" + relative.Replace('/', '\\');
            }
            // Lock every ancestor, including those above the configured root.
            string volume = Path.GetPathRoot(combined);
            string current = volume;
            var segments = combined.Substring(volume.Length).Split('\\');
            handles.Add(Open(current, true)); names.Add(current);
            bool listing = operation == "list";
            if (!listing && operation != "read") throw Deny();
            for (int i = 0; i < segments.Length; i++) {
                current = Path.Combine(current, segments[i]);
                bool dir = listing || i < segments.Length - 1;
                handles.Add(Open(current, dir)); names.Add(current);
            }
            object result;
            if (listing) {
                var entries = new List<object>();
                int scanned = 0;
                bool more = false;
                bool capped = false;
                foreach (string entry in System.IO.Directory.EnumerateFileSystemEntries(combined)) {
                    if (scanned++ < offset) continue;
                    if (scanned > 5000) { capped = true; break; }
                    if (entries.Count >= limit) { more = true; break; }
                    string name = Path.GetFileName(entry);
                    if (Private(name)) continue;
                    try {
                        var attributes = File.GetAttributes(entry);
                        if ((attributes & FileAttributes.ReparsePoint) != 0) continue;
                        bool dir = (attributes & FileAttributes.Directory) != 0;
                        using (var entryHandle = Open(entry, dir)) {
                            var info = Inspect(entryHandle);
                            long size = ((long)info.sizeHigh << 32) | info.sizeLow;
                            long write = ((long)info.write.dwHighDateTime << 32) | (uint)info.write.dwLowDateTime;
                            entries.Add(new { name = name, type = dir ? "directory" : "file", size = dir ? (long?)null : size, modifiedAt = DateTime.FromFileTimeUtc(write).ToString("o") });
                        }
                    } catch (IOException) {} catch (UnauthorizedAccessException) {}
                }
                // offset counts examined entries (including filtered names).
                result = new { entries = entries, nextCursor = more ? (int?)(scanned - 1) : null, truncated = capped };
            } else {
                var handle = handles[handles.Count - 1];
                var before = Inspect(handle);
                long size = ((long)before.sizeHigh << 32) | before.sizeLow;
                if (size > maxBytes) throw new IOException("BODY_TOO_LARGE");
                byte[] bytes = new byte[(int)size];
                using (var stream = new FileStream(handle, FileAccess.Read)) {
                    int read = 0;
                    while (read < bytes.Length) {
                        int count = stream.Read(bytes, read, bytes.Length - read);
                        if (count == 0) throw Deny();
                        read += count;
                    }
                    if (stream.ReadByte() != -1) throw new IOException("BODY_TOO_LARGE");
                    var after = Inspect(handle);
                    if (after.sizeHigh != before.sizeHigh || after.sizeLow != before.sizeLow || after.write.dwHighDateTime != before.write.dwHighDateTime || after.write.dwLowDateTime != before.write.dwLowDateTime) throw Deny();
                    // Verify before FileStream disposes the file handle.
                    if (!String.Equals(Final(handle), combined, StringComparison.OrdinalIgnoreCase)) throw Deny();
                }
                handles.RemoveAt(handles.Count - 1); names.RemoveAt(names.Count - 1);
                result = new { base64 = Convert.ToBase64String(bytes), size = bytes.Length };
            }
            for (int i = 0; i < handles.Count; i++) {
                Inspect(handles[i]);
                if (!String.Equals(Final(handles[i]), names[i].TrimEnd('\\'), StringComparison.OrdinalIgnoreCase)) throw Deny();
            }
            return result;
        } finally { foreach (var handle in handles) handle.Dispose(); }
    }
}
