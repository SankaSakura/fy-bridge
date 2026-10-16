using System;
using System.Diagnostics;
using System.IO;
using System.Text;
using System.Threading;

// Small binary entry point required by Chrome on Windows. Node owns the
// application logic; stdout here carries native messaging frames only.
internal static class Launcher
{
    private static byte[] ReadExactly(Stream input, int count)
    {
        byte[] bytes = new byte[count];
        int offset = 0;
        while (offset < count)
        {
            int read = input.Read(bytes, offset, count - offset);
            if (read == 0) throw new EndOfStreamException();
            offset += read;
        }
        return bytes;
    }

    private static string Quote(string value)
    {
        // Both arguments are file paths and cannot contain double quotes.
        if (value.IndexOf('"') >= 0) throw new InvalidDataException();
        return "\"" + value + "\"";
    }

    public static int Main(string[] args)
    {
        try
        {
            string directory = AppDomain.CurrentDomain.BaseDirectory;
            string origin = File.ReadAllText(Path.Combine(directory, "allowed-origin.txt")).Trim();
            if (args.Length == 0 || !String.Equals(args[0].TrimEnd('/'), origin.TrimEnd('/'), StringComparison.Ordinal))
                throw new InvalidDataException();
            string root = Path.GetFullPath(Path.Combine(directory, "..", ".."));
            string node = File.ReadAllText(Path.Combine(directory, "node-path.txt")).Trim();
            if (!File.Exists(node)) throw new FileNotFoundException();
            Stream input = Console.OpenStandardInput();
            ProcessStartInfo info = new ProcessStartInfo(node, Quote(Path.Combine(root, "native", "host.mjs")));
            info.UseShellExecute = false;
            info.CreateNoWindow = true;
            info.WorkingDirectory = root;
            info.RedirectStandardInput = true;
            info.RedirectStandardOutput = true;
            info.RedirectStandardError = true;
            using (Process child = Process.Start(info))
            {
                // Drain diagnostics separately; never mix them into JSON stdout.
                child.ErrorDataReceived += delegate { };
                child.BeginErrorReadLine();
                // Relay a live native port. Closing a settings tab does not
                // close Chrome's background connection to this process.
                Thread relay = new Thread(delegate() {
                    try {
                        while (true) {
                            byte[] header = ReadExactly(input, 4);
                            uint size = BitConverter.ToUInt32(header, 0);
                            if (size == 0 || size > 65536) break;
                            byte[] message = ReadExactly(input, (int)size);
                            child.StandardInput.BaseStream.Write(header, 0, header.Length);
                            child.StandardInput.BaseStream.Write(message, 0, message.Length);
                            child.StandardInput.BaseStream.Flush();
                        }
                    } catch (IOException) { }
                      catch (ObjectDisposedException) { }
                    finally { try { child.StandardInput.Close(); } catch { } }
                });
                relay.IsBackground = true;
                relay.Start();
                child.StandardOutput.BaseStream.CopyTo(Console.OpenStandardOutput());
                child.WaitForExit();
                return child.ExitCode;
            }
        }
        catch
        {
            byte[] error = Encoding.UTF8.GetBytes("{\"ok\":false,\"error\":\"本地启动器无法运行。请确认已安装 Node.js 22 或更高版本，然后重新运行安装FY反代.cmd。\"}");
            Stream output = Console.OpenStandardOutput();
            byte[] length = BitConverter.GetBytes(error.Length);
            output.Write(length, 0, length.Length);
            output.Write(error, 0, error.Length);
            output.Flush();
            return 1;
        }
    }
}
