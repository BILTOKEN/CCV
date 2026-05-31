using System;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Diagnostics;
using System.Windows.Forms;
using System.IO;
using System.Collections.Generic;
using System.Net;
using System.Net.Sockets;
using System.Threading.Tasks;

namespace ClaudeLauncher
{
    class Program
    {
        internal const string APP_VERSION = "v4.2.0";
        internal const string DEV_NAME = "Bill偷啃";
        internal const string DEV_BILIBILI = "B站 @Bill偷啃";

        internal static string ROOT;
        internal static string CMD_PATH;
        internal static string DATA_DIR;
        internal static string ENV_FILE;
        internal static string CLAUDE_SETTINGS;

        [STAThread]
        static void Main()
        {
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);

            ROOT = Path.Combine(Path.GetDirectoryName(Application.ExecutablePath), "_runtime");
            CMD_PATH = Path.Combine(Environment.SystemDirectory, "cmd.exe");
            DATA_DIR = Path.Combine(ROOT, "data");
            ENV_FILE = Path.Combine(DATA_DIR, "ai_settings.env");
            CLAUDE_SETTINGS = Path.Combine(ROOT, ".claude", "settings.json");

            Application.Run(new LauncherForm());
        }

        internal static void RunBat(string batName)
        {
            try
            {
                Process.Start(new ProcessStartInfo
                {
                    FileName = CMD_PATH,
                    Arguments = "/c start \"\" /D \"" + ROOT + "\" \"" + Path.Combine(ROOT, "scripts", batName) + "\"",
                    UseShellExecute = false,
                    CreateNoWindow = true
                });
            }
            catch { }
        }

        internal static void RunCommand(string cmd)
        {
            try
            {
                Process.Start(new ProcessStartInfo
                {
                    FileName = CMD_PATH,
                    Arguments = "/c " + cmd,
                    UseShellExecute = false,
                    CreateNoWindow = true
                });
            }
            catch { }
        }

        // 静默启动服务器（无黑窗口，设置正确的工作目录）
        internal static void StartDashboardSilently()
        {
            try
            {
                string nodePath = Path.Combine(ROOT, "node", "node.exe");
                string serverPath = Path.Combine(ROOT, "dashboard", "server.mjs");
                string gitPath = Path.Combine(ROOT, "PortableGit", "mingw64", "bin");
                string gitCmdPath = Path.Combine(ROOT, "PortableGit", "cmd");

                var psi = new ProcessStartInfo
                {
                    FileName = nodePath,
                    Arguments = "\"" + serverPath + "\"",
                    WorkingDirectory = ROOT,
                    UseShellExecute = false,
                    CreateNoWindow = true
                };
                // 注入 PATH，让服务器内部调用系统命令时能找到
                string existingPath = Environment.GetEnvironmentVariable("PATH") ?? "";
                psi.EnvironmentVariables["PATH"] = Path.Combine(ROOT, "node") + ";" + gitPath + ";" + gitCmdPath + ";" + existingPath;
                Process.Start(psi);
            }
            catch { }
        }

        // 启动 Claude Code 终端（需要可见窗口）
        internal static void StartClaudeTerminal()
        {
            try
            {
                Process.Start(new ProcessStartInfo
                {
                    FileName = CMD_PATH,
                    Arguments = "/c start \"Claude Code\" /D \"" + ROOT + "\" \"" + Path.Combine(ROOT, "scripts", "启动Claude Code.bat") + "\"",
                    UseShellExecute = true
                });
            }
            catch { }
        }

        // 停止 Dashboard 服务器（只杀端口 3000 的进程，不影响 Claude Code）
        internal static void StopDashboardServer()
        {
            try
            {
                int pid = GetProcessOnPort(3000);
                if (pid > 0)
                {
                    try { Process.GetProcessById(pid).Kill(); } catch { }
                }
            }
            catch { }
        }

        // ─── 代理服务器管理 ─────────────────────────────────
        internal static void StartProxyServer()
        {
            try
            {
                string nodePath = Path.Combine(ROOT, "node", "node.exe");
                string proxyPath = Path.Combine(ROOT, "dashboard", "proxy.mjs");
                var psi = new ProcessStartInfo
                {
                    FileName = nodePath, Arguments = "\"" + proxyPath + "\"",
                    WorkingDirectory = ROOT, UseShellExecute = false, CreateNoWindow = true
                };
                string existingPath = Environment.GetEnvironmentVariable("PATH") ?? "";
                psi.EnvironmentVariables["PATH"] = Path.Combine(ROOT, "node") + ";" + existingPath;
                Process.Start(psi);
            }
            catch { }
        }

        internal static void StopProxyServer()
        {
            try
            {
                int pid = GetProcessOnPort(3005);
                if (pid > 0) { try { Process.GetProcessById(pid).Kill(); } catch { } }
            }
            catch { }
        }

        internal static void WriteClaudeSettings(string model, string apiKey)
        {
            try
            {
                var dir = Path.Combine(ROOT, ".claude");
                if (!Directory.Exists(dir)) Directory.CreateDirectory(dir);
                File.WriteAllText(Path.Combine(dir, "settings.json"),
                    "{\n  \"env\": {\n" +
                    "    \"ANTHROPIC_AUTH_TOKEN\": \"" + apiKey + "\",\n" +
                    "    \"ANTHROPIC_BASE_URL\": \"http://localhost:3005\",\n" +
                    "    \"ANTHROPIC_DEFAULT_HAIKU_MODEL\": \"" + model + "\",\n" +
                    "    \"ANTHROPIC_DEFAULT_OPUS_MODEL\": \"" + model + "\",\n" +
                    "    \"ANTHROPIC_DEFAULT_SONNET_MODEL\": \"" + model + "\",\n" +
                    "    \"ANTHROPIC_MODEL\": \"" + model + "\"\n" +
                    "  },\n  \"theme\": \"auto\"\n}\n");
            }
            catch { }
        }

        // 直连版：终端直接连 Anthropic 兼容 API，不走代理
        internal static void WriteClaudeSettingsDirect(string model, string apiKey, string anthropicUrl)
        {
            try
            {
                var dir = Path.Combine(ROOT, ".claude");
                if (!Directory.Exists(dir)) Directory.CreateDirectory(dir);
                File.WriteAllText(Path.Combine(dir, "settings.json"),
                    "{\n  \"env\": {\n" +
                    "    \"ANTHROPIC_AUTH_TOKEN\": \"" + apiKey + "\",\n" +
                    "    \"ANTHROPIC_BASE_URL\": \"" + anthropicUrl + "\",\n" +
                    "    \"ANTHROPIC_DEFAULT_HAIKU_MODEL\": \"" + model + "\",\n" +
                    "    \"ANTHROPIC_DEFAULT_OPUS_MODEL\": \"" + model + "\",\n" +
                    "    \"ANTHROPIC_DEFAULT_SONNET_MODEL\": \"" + model + "\",\n" +
                    "    \"ANTHROPIC_MODEL\": \"" + model + "\"\n" +
                    "  },\n  \"theme\": \"auto\"\n}\n");
            }
            catch { }
        }

        // 检查端口 3000 是否在监听
        internal static bool IsPortListening(int port)
        {
            try
            {
                using (var client = new TcpClient())
                {
                    var result = client.BeginConnect("127.0.0.1", port, null, null);
                    var success = result.AsyncWaitHandle.WaitOne(1000);
                    if (!success) return false;
                    client.EndConnect(result);
                    return true;
                }
            }
            catch { return false; }
        }

        // 从 netstat 获取占用端口的 PID
        internal static int GetProcessOnPort(int port)
        {
            try
            {
                var psi = new ProcessStartInfo
                {
                    FileName = "netstat.exe",
                    Arguments = "-ano",
                    UseShellExecute = false,
                    CreateNoWindow = true,
                    RedirectStandardOutput = true
                };
                using (var p = Process.Start(psi))
                {
                    string output = p.StandardOutput.ReadToEnd();
                    p.WaitForExit();
                    foreach (var line in output.Split('\n'))
                    {
                        if (line.Contains(":" + port) && line.Contains("LISTENING"))
                        {
                            var parts = line.Trim().Split(new[] { ' ' }, StringSplitOptions.RemoveEmptyEntries);
                            if (parts.Length >= 5)
                            {
                                int pid;
                                if (int.TryParse(parts[parts.Length - 1], out pid)) return pid;
                            }
                        }
                    }
                }
            }
            catch { }
            return 0;
        }

        // 检查文件是否存在
        internal static bool CoreFilesExist(out string missing)
        {
            missing = "";
            string[] files = {
                Path.Combine(ROOT, "dashboard", "server.mjs"),
                Path.Combine(ROOT, "dashboard", "index.html"),
                Path.Combine(ROOT, "dashboard", "proxy.mjs"),
                Path.Combine(ROOT, "node", "node.exe")
            };
            var missingList = new List<string>();
            foreach (var f in files)
            {
                if (!File.Exists(f)) missingList.Add(Path.GetFileName(f));
            }
            missing = string.Join("、", missingList.ToArray());
            return missingList.Count == 0;
        }
    }

    // 配色
    class Colors
    {
        public static Color Bg = Color.FromArgb(18, 20, 28);
        public static Color Surface = Color.FromArgb(27, 30, 42);
        public static Color SurfaceHover = Color.FromArgb(35, 39, 54);
        public static Color Border = Color.FromArgb(50, 55, 75);
        public static Color BorderActive = Color.FromArgb(59, 130, 246);
        public static Color Accent = Color.FromArgb(59, 130, 246);
        public static Color AccentDark = Color.FromArgb(37, 99, 235);
        public static Color Text = Color.FromArgb(236, 239, 245);
        public static Color TextDim = Color.FromArgb(128, 136, 158);
        public static Color Green = Color.FromArgb(34, 197, 94);
        public static Color Red = Color.FromArgb(239, 68, 68);
        public static Color Orange = Color.FromArgb(245, 158, 11);
    }

    // 主窗口
    class LauncherForm : Form
    {
        Label toastLabel;
        Timer toastTimer;
        Timer dashboardCheckTimer;
        Button apiBtn;
        Label apiBtnTitle;
        Label apiBtnDesc;
        bool apiConfigured;
        string detectedProvider = "";
        string detectedModel = "";
        string detectedApiUrl = "";
        string detectedApiKey = "";
        int apiStatus = 0;
        string detectedError = "";
        Label apiDot;
        Label apiStatusText;
        Label dashboardDot;
        Label dashboardStatusText;
        Label proxyDot;
        Label proxyStatusText;

        public LauncherForm()
        {
            this.Text = "CCV 启动器 " + Program.APP_VERSION + " | " + Program.DEV_NAME;
            this.Size = new Size(640, 800);
            this.StartPosition = FormStartPosition.CenterScreen;
            this.FormBorderStyle = FormBorderStyle.Sizable;
            this.MinimumSize = new Size(640, 760);
            this.BackColor = Colors.Bg;
            this.ForeColor = Colors.Text;
            this.Font = new Font("Segoe UI", 10);
            this.Icon = null;

            BuildUI();
            InitToast();
            StartDashboardTimer();

            // 启动代理服务器并定时检查状态
            this.Shown += (s, e) => {
                Program.StartProxyServer();
                CheckProxyStatus();
            };
            this.FormClosing += (s, e) => {
                Program.StopProxyServer();
                Program.StopDashboardServer();
                // 清理 Claude Code 通知残留文件
                CleanNotifyJunk();
            };
        }

        void StartDashboardTimer()
        {
            dashboardCheckTimer = new Timer { Interval = 5000 };
            dashboardCheckTimer.Tick += (s, e) => CheckDashboardStatus();
            dashboardCheckTimer.Start();
            // 首次立即检查
            CheckDashboardStatus();
        }

        void CleanNotifyJunk()
        {
            try
            {
                foreach (var f in Directory.GetFiles(Program.ROOT, "*claude-notify*"))
                    File.Delete(f);
                foreach (var f in Directory.GetFiles(Program.ROOT, "*claude*stop*"))
                    File.Delete(f);
            }
            catch { }
        }

        void CheckDashboardStatus()
        {
            if (dashboardDot == null || dashboardStatusText == null) return;
            bool running = Program.IsPortListening(3000);
            if (running)
            {
                dashboardDot.ForeColor = Colors.Green;
                dashboardStatusText.Text = "Dashboard ● 运行中";
                dashboardStatusText.ForeColor = Colors.Green;
            }
            else
            {
                dashboardDot.ForeColor = Color.FromArgb(239, 68, 68);
                dashboardStatusText.Text = "Dashboard ● 未启动";
                dashboardStatusText.ForeColor = Color.FromArgb(239, 68, 68);
            }
            CheckProxyStatus();
        }

        void CheckProxyStatus()
        {
            if (proxyDot == null || proxyStatusText == null) return;
            bool running = Program.IsPortListening(3005);
            if (running)
            {
                proxyDot.ForeColor = Colors.Green;
                proxyStatusText.Text = "API 代理 ● 运行中";
                proxyStatusText.ForeColor = Colors.Green;
            }
            else
            {
                proxyDot.ForeColor = Color.FromArgb(239, 68, 68);
                proxyStatusText.Text = "API 代理 ● 未启动";
                proxyStatusText.ForeColor = Color.FromArgb(239, 68, 68);
            }
        }

        void BuildUI()
        {
            int cX = 40;
            int cW = 560;
            int gap = 18;
            int btnH = 70;

            PictureBox logo = new PictureBox {
                Location = new Point(cX, 24),
                Size = new Size(52, 52),
                SizeMode = PictureBoxSizeMode.Zoom
            };
            try {
                var avatarPath = Path.Combine(Program.ROOT, "images", "avatar.png");
                if (File.Exists(avatarPath)) {
                    logo.Image = Image.FromFile(avatarPath);
                }
            } catch {}
            // 圆形裁剪
            logo.Paint += (s, e) => {
                var g = e.Graphics;
                g.SmoothingMode = SmoothingMode.AntiAlias;
                var path = new GraphicsPath();
                path.AddEllipse(0, 0, logo.Width - 1, logo.Height - 1);
                logo.Region = new Region(path);
            };

            var title = new Label
            {
                Text = "CCV v4.2（Claude Code Vision）",
                Font = new Font("Segoe UI", 22, FontStyle.Bold),
                ForeColor = Colors.Text,
                Location = new Point(cX + 56, 28),
                Size = new Size(480, 40),
                TextAlign = ContentAlignment.MiddleLeft
            };

            var subtitle = new Label
            {
                Text = "选择一个模式开始使用",
                Font = new Font("Segoe UI", 10),
                ForeColor = Colors.TextDim,
                Location = new Point(cX + 56, 66),
                Size = new Size(480, 26)
            };

            var divider = new Panel
            {
                Location = new Point(cX, 106),
                Size = new Size(cW, 1),
                BackColor = Colors.Border
            };

            int cardY = 128;

            // 按钮 1: AI 网页版
            var btn1 = MakeButton(
                "🌐  AI 网页版",
                "浏览器界面，支持 DeepSeek / OpenAI / Claude / Gemini 等",
                cardY, cX, cW
            );
            btn1.Click += (s, e) => {
                Program.StartDashboardSilently();
                // 打开浏览器访问 Dashboard
                try { Process.Start("http://localhost:3000"); } catch { }
                ShowToast("正在静默启动 AI 网页版... http://localhost:3000");
            };

            // 按钮 2: Claude Code 终端
            var btn2 = MakeButton(
                "💻  Claude Code 终端",
                "命令行界面，完整编程功能",
                cardY + (btnH + gap), cX, cW
            );
            btn2.Click += (s, e) => {
                Program.StartClaudeTerminal();
                ShowToast("正在启动 Claude Code 终端...");
            };

            // 按钮 3: 配置 API
            apiBtn = MakeButton(
                "🔑  配置 API 密钥",
                "一键设置 AI 提供商和密钥，同时配置网页版和终端",
                cardY + (btnH + gap) * 2, cX, cW
            );
            apiBtnTitle = (Label)apiBtn.Controls[0];
            apiBtnDesc = (Label)apiBtn.Controls[1];
            apiBtn.Click += (s, e) => {
                using (var cfg = new ConfigForm())
                {
                    cfg.ShowDialog(this);
                    if (cfg.Saved)
                    {
                        RefreshApiStatus();
                        ShowToast("✓ 配置已保存！API 密钥已就绪，可以开始使用");
                    }
                }
            };
            CheckApiConfigured();
            RefreshApiStatus();

            // 按钮 4: 工作目录
            var btn4 = MakeButton(
                "📂  打开工作目录",
                "在文件管理器中查看 workspace 文件夹",
                cardY + (btnH + gap) * 3, cX, cW
            );
            btn4.Click += (s, e) => {
                var ws = Path.Combine(Program.ROOT, "workspace");
                if (!Directory.Exists(ws)) Directory.CreateDirectory(ws);
                Process.Start("explorer.exe", ws);
            };

            // 按钮 5: 故障检测与自动修复
            var btn5 = MakeButton(
                "🔧  故障检测与自动修复",
                "打不开终端 / 网页端 / 按钮没反应？一键诊断并修复",
                cardY + (btnH + gap) * 4, cX, cW
            );
            btn5.Click += (s, e) => {
                using (var diag = new TroubleshootingForm())
                {
                    diag.ShowDialog(this);
                    RefreshApiStatus();      // 配置可能已在诊断窗口中修改
                    CheckDashboardStatus();
                }
            };

            // 按钮 6: VS Code 编辑器
            var btn6 = MakeButton(
                "📝  VS Code 编辑器",
                "便携版 VS Code，完整 AI 编程环境，支持 Claude Code 扩展",
                cardY + (btnH + gap) * 5, cX, cW
            );
            btn6.Click += (s, e) => {
                var vsCodeExe = Path.Combine(Program.ROOT, "VSCode", "Code.exe");
                var ws = Path.Combine(Program.ROOT, "workspace");
                if (!Directory.Exists(ws)) Directory.CreateDirectory(ws);
                if (File.Exists(vsCodeExe))
                {
                    try
                    {
                        string nodePath = Path.Combine(Program.ROOT, "node");
                        string gitPath = Path.Combine(Program.ROOT, "PortableGit", "mingw64", "bin");
                        string gitCmdPath = Path.Combine(Program.ROOT, "PortableGit", "cmd");
                        var psi = new ProcessStartInfo
                        {
                            FileName = vsCodeExe,
                            Arguments = "\"" + ws + "\"",
                            UseShellExecute = false
                        };
                        string existingPath = Environment.GetEnvironmentVariable("PATH") ?? "";
                        psi.EnvironmentVariables["PATH"] = nodePath + ";" + gitPath + ";" + gitCmdPath + ";" + existingPath;
                        psi.EnvironmentVariables["CLAUDE_CONFIG_DIR"] = Path.Combine(Program.ROOT, ".claude");
                        psi.EnvironmentVariables["NPM_CONFIG_CACHE"] = Path.Combine(Program.ROOT, ".npm-cache");
                        Process.Start(psi);
                    }
                    catch { }
                    ShowToast("VS Code 已启动，终端自动运行 Claude Code");
                }
                else
                {
                    ShowToast("未找到 VS Code，请确认 VSCode 文件夹存在");
                }
            };

            // 状态栏（使用 Dock 固定到底部）
            var statusBar = new Panel
            {
                Dock = DockStyle.Bottom,
                Height = 74,
                BackColor = Colors.Surface
            };
            // API 状态行
            apiDot = new Label
            {
                Text = "●",
                Font = new Font("Segoe UI", 10),
                ForeColor = apiConfigured ? Colors.Green : Color.FromArgb(239, 68, 68),
                Location = new Point(cX, 10),
                Size = new Size(16, 22),
                TextAlign = ContentAlignment.MiddleLeft,
                BackColor = Color.Transparent
            };
            apiStatusText = new Label
            {
                Text = apiConfigured ? string.Format("{0} · {1}", detectedModel, GetProviderDisplay(detectedProvider)) : "未配置 API",
                Font = new Font("Segoe UI", 8),
                ForeColor = apiConfigured ? Colors.Green : Color.FromArgb(239, 68, 68),
                Location = new Point(cX + 18, 10),
                Size = new Size(200, 22),
                TextAlign = ContentAlignment.MiddleLeft,
                BackColor = Color.Transparent,
                AutoSize = false
            };
            // Dashboard 状态行
            dashboardDot = new Label
            {
                Text = "●",
                Font = new Font("Segoe UI", 10),
                ForeColor = Color.FromArgb(239, 68, 68),
                Location = new Point(cX, 30),
                Size = new Size(16, 22),
                TextAlign = ContentAlignment.MiddleLeft,
                BackColor = Color.Transparent
            };
            dashboardStatusText = new Label
            {
                Text = "Dashboard ● 检测中...",
                Font = new Font("Segoe UI", 8),
                ForeColor = Colors.TextDim,
                Location = new Point(cX + 18, 30),
                Size = new Size(200, 22),
                TextAlign = ContentAlignment.MiddleLeft,
                BackColor = Color.Transparent,
                AutoSize = false
            };
            // 代理状态行
            proxyDot = new Label
            {
                Text = "●",
                Font = new Font("Segoe UI", 10),
                ForeColor = Color.FromArgb(239, 68, 68),
                Location = new Point(cX, 52),
                Size = new Size(16, 22),
                TextAlign = ContentAlignment.MiddleLeft,
                BackColor = Color.Transparent
            };
            proxyStatusText = new Label
            {
                Text = "API 代理 ● 检测中...",
                Font = new Font("Segoe UI", 8),
                ForeColor = Colors.TextDim,
                Location = new Point(cX + 18, 52),
                Size = new Size(200, 22),
                TextAlign = ContentAlignment.MiddleLeft,
                BackColor = Color.Transparent,
                AutoSize = false
            };
            var statusLabel = new Label
            {
                Text = "📂 " + Program.ROOT,
                Font = new Font("Segoe UI", 8),
                ForeColor = Colors.TextDim,
                Location = new Point(cX + 230, 8),
                Size = new Size(150, 22),
                AutoSize = false
            };
            var aboutLink = new Label
            {
                Text = "关于 CCV",
                Font = new Font("Segoe UI", 8, FontStyle.Underline),
                ForeColor = Color.FromArgb(80, 200, 120),
                Location = new Point(cX + 495, 52),
                Size = new Size(55, 22),
                TextAlign = ContentAlignment.MiddleRight,
                Cursor = Cursors.Hand
            };
            aboutLink.Click += (s, e) => { using (var f = new AboutForm()) f.ShowDialog(); };
            aboutLink.MouseEnter += (s, e) => aboutLink.ForeColor = Colors.Accent;
            aboutLink.MouseLeave += (s, e) => aboutLink.ForeColor = Colors.TextDim;

            var devLabel = new Label
            {
                Text = Program.APP_VERSION + " | " + Program.DEV_BILIBILI,
                Font = new Font("Segoe UI", 8),
                ForeColor = Colors.TextDim,
                Location = new Point(cX + 410, 52),
                Size = new Size(82, 22),
                TextAlign = ContentAlignment.MiddleRight,
                AutoSize = false
            };
            statusBar.Controls.AddRange(new Control[] {
                apiDot, apiStatusText, dashboardDot, dashboardStatusText,
                proxyDot, proxyStatusText,
                statusLabel, devLabel, aboutLink
            });

            Controls.AddRange(new Control[] {
                logo, title, subtitle, divider,
                btn1, btn2, apiBtn, btn4, btn5, btn6,
                statusBar
            });
        }

        Button MakeButton(string label, string desc, int y, int x, int w)
        {
            var btn = new Button
            {
                Text = "",
                Location = new Point(x, y),
                Size = new Size(w, 70),
                FlatStyle = FlatStyle.Flat,
                FlatAppearance = { BorderSize = 0 },
                BackColor = Colors.Surface,
                ForeColor = Colors.Text,
                TextAlign = ContentAlignment.MiddleLeft,
                Padding = new Padding(0),
                Cursor = Cursors.Hand
            };

            var titleLbl = new Label
            {
                Text = label,
                Font = new Font("Segoe UI", 13, FontStyle.Bold),
                ForeColor = Colors.Text,
                Location = new Point(20, 10),
                Size = new Size(w - 80, 26),
                BackColor = Color.Transparent,
                Enabled = false
            };

            var descLbl = new Label
            {
                Text = desc,
                Font = new Font("Segoe UI", 9),
                ForeColor = Colors.TextDim,
                Location = new Point(20, 38),
                Size = new Size(w - 20, 22),
                BackColor = Color.Transparent,
                Enabled = false
            };

            btn.Controls.Add(titleLbl);
            btn.Controls.Add(descLbl);

            btn.Paint += (s, e) => {
                var rect = new Rectangle(1, 1, btn.Width - 3, btn.Height - 3);
                using (var path = RoundedRect(rect, 10))
                {
                    e.Graphics.SmoothingMode = SmoothingMode.AntiAlias;
                    using (var brush = new SolidBrush(btn.BackColor))
                        e.Graphics.FillPath(brush, path);
                    using (var pen = new Pen(btn.FlatAppearance.BorderColor, 1.5f))
                        e.Graphics.DrawPath(pen, path);
                }
            };

            btn.MouseEnter += (s, e) => {
                btn.BackColor = Colors.SurfaceHover;
                btn.FlatAppearance.BorderColor = Colors.BorderActive;
                titleLbl.ForeColor = Colors.Accent;
            };
            btn.MouseLeave += (s, e) => {
                btn.BackColor = Colors.Surface;
                btn.FlatAppearance.BorderColor = Colors.Border;
                titleLbl.ForeColor = Colors.Text;
            };

            return btn;
        }

        void CheckApiConfigured()
        {
            apiConfigured = false;
            detectedProvider = "";
            detectedModel = "";
            detectedApiUrl = "";
            detectedApiKey = "";
            try
            {
                if (!File.Exists(Program.ENV_FILE)) return;
                string provider = "", model = "", key = "", url = "";
                foreach (var line in File.ReadAllLines(Program.ENV_FILE))
                {
                    var t = line.Trim();
                    if (t == "" || t.StartsWith("#") || !t.Contains("=")) continue;
                    int eq = t.IndexOf('=');
                    string k = t.Substring(0, eq).Trim();
                    string v = t.Substring(eq + 1).Trim();
                    if (k == "AI_PROVIDER") provider = v;
                    else if (k == "AI_DISPLAY_MODEL") model = v;
                    else if (k.Contains("BASE_URL")) url = v;
                    else if (k.Contains("API_KEY") && v != "" && !v.Contains("你的") && !v.Contains("sk-你的"))
                        key = v;
                }
                if (key != "")
                {
                    apiConfigured = true;
                    detectedProvider = provider;
                    detectedModel = model;
                    detectedApiUrl = url;
                    detectedApiKey = key;
                }
            }
            catch { }
        }

        string GetProviderDisplay(string code)
        {
            switch (code)
            {
                case "openai": return "OpenAI";
                case "anthropic": return "Claude";
                case "gemini": return "Gemini";
                case "openrouter": return "OpenRouter";
                case "ollama": return "Ollama";
                default: return string.IsNullOrEmpty(code) ? "未知" : code;
            }
        }

        void UpdateApiBtnStyle()
        {
            if (apiConfigured)
            {
                apiBtn.FlatAppearance.BorderColor = Colors.Border;
                apiBtnTitle.ForeColor = Colors.Text;
                apiBtnDesc.Text = "一键设置 AI 提供商和密钥，同时配置网页版和终端";
                apiBtnDesc.ForeColor = Colors.TextDim;
            }
            else
            {
                apiBtn.FlatAppearance.BorderColor = Color.FromArgb(239, 68, 68);
                apiBtnTitle.ForeColor = Color.FromArgb(239, 68, 68);
                apiBtnDesc.Text = "⚠ 尚未配置 API 密钥，点击此处设置";
                apiBtnDesc.ForeColor = Color.FromArgb(239, 68, 68);
            }
            apiBtn.Invalidate();
        }

        void RefreshApiStatus()
        {
            CheckApiConfigured();
            UpdateApiBtnStyle();
            if (apiDot == null || apiStatusText == null) return;

            if (!apiConfigured)
            {
                apiStatus = 0;
                detectedError = "";
                SetStatusColor(Color.FromArgb(239, 68, 68));
                apiStatusText.Text = "未配置 API";
            }
            else
            {
                apiStatus = 3;
                detectedError = "";
                SetStatusColor(Color.FromArgb(245, 158, 11));
                apiStatusText.Text = string.Format("{0} · {1} 验证中...", detectedModel, GetProviderDisplay(detectedProvider));
                VerifyApiConnectivity();
            }
        }

        void VerifyApiConnectivity()
        {
            System.Threading.Tasks.Task.Factory.StartNew(delegate()
            {
                try
                {
                    string url = "";
                    string key = detectedApiKey;
                    string baseUrl = detectedApiUrl;

                    if (detectedProvider == "openrouter")
                    {
                        url = "https://openrouter.ai/api/v1/auth/key";
                        var req = WebRequest.Create(url);
                        req.Headers["Authorization"] = "Bearer " + key;
                        req.Timeout = 8000;
                        using (var resp = req.GetResponse()) { }
                    }
                    else if (detectedProvider == "anthropic")
                    {
                        url = (baseUrl != "" ? baseUrl : "https://api.anthropic.com/v1") + "/models";
                        var req = WebRequest.Create(url);
                        req.Headers["x-api-key"] = key;
                        req.Headers["anthropic-version"] = "2023-06-01";
                        req.Timeout = 8000;
                        using (var resp = req.GetResponse()) { }
                    }
                    else if (detectedProvider == "gemini")
                    {
                        apiStatus = 1;
                        detectedError = "";
                        this.Invoke(new Action(delegate() { ApplyVerifyResult(); }));
                        return;
                    }
                    else
                    {
                        url = (baseUrl != "" ? baseUrl : "https://api.openai.com/v1") + "/models";
                        var req = WebRequest.Create(url);
                        req.Headers["Authorization"] = "Bearer " + key;
                        req.Timeout = 8000;
                        using (var resp = req.GetResponse()) { }
                    }

                    apiStatus = 1;
                    detectedError = "";
                }
                catch (Exception ex)
                {
                    apiStatus = 2;
                    string msg = ex.Message;
                    if (msg.Contains("(401") || msg.Contains("Unauthorized")) msg = "API Key 无效";
                    else if (msg.Contains("(403") || msg.Contains("Forbidden")) msg = "无权限";
                    else if (msg.Contains("NameResolutionFailure") || msg.Contains("DNS") || msg.Contains("nodename"))
                        msg = "域名解析失败";
                    else if (msg.Contains("timed out") || msg.Contains("Timeout") || msg.Contains("超时"))
                        msg = "连接超时";
                    else if (msg.Contains("No such host") || msg.Contains("connect") || msg.Contains("refused"))
                        msg = "无法连接服务器";
                    else if (msg.Length > 30) msg = msg.Substring(0, 28) + "…";
                    detectedError = msg;
                }

                this.Invoke(new Action(delegate() { ApplyVerifyResult(); }));
            });
        }

        void ApplyVerifyResult()
        {
            if (apiDot == null || apiStatusText == null) return;
            if (apiStatus == 1)
            {
                SetStatusColor(Colors.Green);
                apiStatusText.Text = string.Format("{0} · {1} ✓ 已连接", detectedModel, GetProviderDisplay(detectedProvider));
            }
            else
            {
                SetStatusColor(Color.FromArgb(239, 68, 68));
                apiStatusText.Text = string.Format("{0} · {1} ✗ {2}", detectedModel, GetProviderDisplay(detectedProvider), detectedError);
            }
        }

        void SetStatusColor(Color c)
        {
            if (apiDot != null) apiDot.ForeColor = c;
            if (apiStatusText != null) apiStatusText.ForeColor = c;
        }

        void InitToast()
        {
            toastLabel = new Label
            {
                Font = new Font("Segoe UI", 9, FontStyle.Bold),
                ForeColor = Color.White,
                BackColor = Color.Transparent,
                TextAlign = ContentAlignment.MiddleCenter,
                Location = new Point(40, 620),
                Size = new Size(560, 46),
                Visible = false
            };
            toastLabel.Paint += (s, e) => {
                var rect = new Rectangle(0, 0, toastLabel.Width, toastLabel.Height);
                using (var path = RoundedRect(rect, 10))
                using (var brush = new SolidBrush(Color.FromArgb(230, Colors.AccentDark)))
                {
                    e.Graphics.SmoothingMode = SmoothingMode.AntiAlias;
                    e.Graphics.FillPath(brush, path);
                }
                TextRenderer.DrawText(e.Graphics, toastLabel.Text, toastLabel.Font,
                    rect, Color.White, TextFormatFlags.HorizontalCenter | TextFormatFlags.VerticalCenter);
            };
            toastLabel.TextChanged += (s, e) => toastLabel.Invalidate();
            Controls.Add(toastLabel);
        }

        void ShowToast(string msg)
        {
            toastLabel.Text = msg;
            toastLabel.Visible = true;
            toastLabel.BringToFront();
            if (toastTimer != null) { toastTimer.Stop(); toastTimer.Dispose(); }
            toastTimer = new Timer { Interval = 5000 };
            toastTimer.Tick += (s, e) => {
                toastLabel.Visible = false;
                toastTimer.Stop();
                toastTimer.Dispose();
                toastTimer = null;
            };
            toastTimer.Start();
        }

 static GraphicsPath RoundedRect(Rectangle r, int radius)
        {
            var path = new GraphicsPath();
            int d = radius * 2;
            path.AddLine(r.X + radius, r.Y, r.Right - radius, r.Y);
            path.AddArc(r.Right - d, r.Y, d, d, 270, 90);
            path.AddLine(r.Right, r.Y + radius, r.Right, r.Bottom - radius);
            path.AddArc(r.Right - d, r.Bottom - d, d, d, 0, 90);
            path.AddLine(r.Right - radius, r.Bottom, r.X + radius, r.Bottom);
            path.AddArc(r.X, r.Bottom - d, d, d, 90, 90);
            path.AddLine(r.X, r.Bottom - radius, r.X, r.Y + radius);
            path.AddArc(r.X, r.Y, d, d, 180, 90);
            path.CloseFigure();
            return path;
        }

        protected override void OnPaint(PaintEventArgs e)
        {
            base.OnPaint(e);
            using (var brush = new LinearGradientBrush(
                new Point(0, 0), new Point(Width, 0),
                Colors.Accent, Color.FromArgb(30, Colors.Accent)))
            using (var pen = new Pen(brush, 2))
            {
                e.Graphics.DrawLine(pen, 0, 0, Width, 0);
            }

            string wm = Program.DEV_NAME + "  CC" + Program.APP_VERSION;
            using (var font = new Font("Segoe UI", 20, FontStyle.Regular))
            using (var brush = new SolidBrush(Color.FromArgb(18, Color.White)))
            {
                var sz = e.Graphics.MeasureString(wm, font);
                float stepX = sz.Width + 80;
                float stepY = sz.Height + 60;
                e.Graphics.TranslateTransform(30, 0);
                e.Graphics.RotateTransform(-25);
                for (float y = -stepY; y < Height + stepY; y += stepY)
                {
                    for (float x = -stepX; x < Width + stepX; x += stepX)
                    {
                        e.Graphics.DrawString(wm, font, brush, x, y);
                    }
                }
                e.Graphics.ResetTransform();
            }
        }
    }

    // ─── 关于窗口 ───────────────────────────────────────────
    class AboutForm : Form
    {
        public AboutForm()
        {
            Text = "关于 CCV";
            FormBorderStyle = FormBorderStyle.FixedDialog;
            MaximizeBox = false; MinimizeBox = false;
            StartPosition = FormStartPosition.CenterParent;
            ClientSize = new Size(360, 440);
            BackColor = Color.FromArgb(28, 30, 42);
            Font = new Font("Segoe UI", 9);

            int y = 28;
            var avatarPath = Path.Combine(Program.ROOT, "images", "avatar.png");
            var avatar = new PictureBox { Location = new Point(140, y), Size = new Size(80, 80), SizeMode = PictureBoxSizeMode.Zoom };
            if (File.Exists(avatarPath)) avatar.Image = Image.FromFile(avatarPath);
            avatar.Paint += (s, e) => { using (var g = new GraphicsPath()) { g.AddEllipse(1, 1, 78, 78); avatar.Region = new Region(g); } };
            y += 92;

            var nameLbl = new Label { Text = "Bill偷啃", Font = new Font("Segoe UI", 14, FontStyle.Bold), ForeColor = Color.White, Location = new Point(0, y), Size = new Size(360, 28), TextAlign = ContentAlignment.MiddleCenter };
            y += 24;
            var roleLbl = new Label { Text = "开发者", Font = new Font("Segoe UI", 9), ForeColor = Color.FromArgb(140, 140, 160), Location = new Point(0, y), Size = new Size(360, 18), TextAlign = ContentAlignment.MiddleCenter };
            y += 32;

            // 联系方式 — 简洁三行
            var line1 = MakeContactLine("QQ群  113571528", y);
            y += 26;
            var line2 = MakeContactLine("邮箱  3180074161@qq.com", y);
            y += 26;
            var line3 = new Label { Text = "B站  space.bilibili.com/379802977", Font = new Font("Segoe UI", 9), ForeColor = Color.FromArgb(120, 180, 240), Location = new Point(0, y), Size = new Size(360, 20), TextAlign = ContentAlignment.MiddleCenter, Cursor = Cursors.Hand };
            line3.Click += (s, e) => Process.Start("https://space.bilibili.com/379802977");
            y += 36;

            var tip = new Label { Text = "喜欢 CCV？联系并打赏，在下方加入你的专属头像", Font = new Font("Segoe UI", 9), ForeColor = Color.FromArgb(160, 140, 140), Location = new Point(0, y), Size = new Size(360, 20), TextAlign = ContentAlignment.MiddleCenter };
            y += 32;

            var sep = new Label { Text = "贡献者", Font = new Font("Segoe UI", 10, FontStyle.Bold), ForeColor = Color.FromArgb(180, 180, 200), Location = new Point(0, y), Size = new Size(360, 20), TextAlign = ContentAlignment.MiddleCenter };
            y += 26;

            var contribPanel = new FlowLayoutPanel { Location = new Point(20, y), Size = new Size(320, 110), AutoScroll = true, WrapContents = true };
            LoadContributors(contribPanel);

            Controls.AddRange(new Control[] { avatar, nameLbl, roleLbl, line1, line2, line3, tip, sep, contribPanel });
        }

        Label MakeContactLine(string text, int y)
        {
            return new Label { Text = text, Font = new Font("Segoe UI", 9), ForeColor = Color.FromArgb(200, 200, 210), Location = new Point(0, y), Size = new Size(360, 20), TextAlign = ContentAlignment.MiddleCenter };
        }

        void LoadContributors(FlowLayoutPanel panel)
        {
            try {
                var jsonPath = Path.Combine(Program.ROOT, "images", "contributors.json");
                if (!File.Exists(jsonPath)) return;
                var list = JsonHelper.ParseContributors(File.ReadAllText(jsonPath));
                foreach (var c in list) {
                    var card = new Panel { Size = new Size(90, 115), BackColor = Color.FromArgb(35, 37, 50) };
                    var pic = new PictureBox { Location = new Point(17, 8), Size = new Size(56, 56), SizeMode = PictureBoxSizeMode.Zoom };
                    var af = Path.Combine(Program.ROOT, c.avatar);
                    if (File.Exists(af)) pic.Image = Image.FromFile(af);
                    pic.Paint += (s, e) => { using (var g = new GraphicsPath()) { g.AddEllipse(1, 1, 54, 54); pic.Region = new Region(g); } };
                    var nm = new Label { Text = c.name, Font = new Font("Segoe UI", 8, FontStyle.Bold), ForeColor = Color.White, Location = new Point(0, 66), Size = new Size(90, 18), TextAlign = ContentAlignment.MiddleCenter };
                    var rl = new Label { Text = c.role, Font = new Font("Segoe UI", 7), ForeColor = Color.FromArgb(150, 150, 170), Location = new Point(0, 82), Size = new Size(90, 16), TextAlign = ContentAlignment.MiddleCenter };
                    card.Controls.AddRange(new Control[] { pic, nm, rl });
                    panel.Controls.Add(card);
                }
            } catch {}
        }
    }

    class Contributor
    {
        public string name;
        public string role;
        public string avatar;
    }

    static class JsonHelper
    {
        public static List<Contributor> ParseContributors(string json)
        {
            var result = new List<Contributor>();
            int pos = 0;
            while (pos < json.Length) {
                int objStart = json.IndexOf('{', pos);
                if (objStart < 0) break;
                int objEnd = json.IndexOf('}', objStart);
                if (objEnd < 0) break;
                string obj = json.Substring(objStart + 1, objEnd - objStart - 1);
                var c = new Contributor();
                c.name = ExtractJsonValue(obj, "name");
                c.role = ExtractJsonValue(obj, "role");
                c.avatar = ExtractJsonValue(obj, "avatar");
                if (!string.IsNullOrEmpty(c.name)) result.Add(c);
                pos = objEnd + 1;
            }
            return result;
        }

        static string ExtractJsonValue(string obj, string key)
        {
            int keyIdx = obj.IndexOf("\"" + key + "\"");
            if (keyIdx < 0) return "";
            int colonIdx = obj.IndexOf(':', keyIdx);
            if (colonIdx < 0) return "";
            int valStart = obj.IndexOf('"', colonIdx);
            if (valStart < 0) return "";
            int valEnd = obj.IndexOf('"', valStart + 1);
            if (valEnd < 0) return "";
            return obj.Substring(valStart + 1, valEnd - valStart - 1);
        }
    }

    // ─── 故障检测与自动修复窗口 ─────────────────────────────────
    class TroubleshootingForm : Form
    {
        Panel itemsPanel;
        Dictionary<string, Label> resultLabels = new Dictionary<string, Label>();
        Dictionary<string, Button> fixButtons = new Dictionary<string, Button>();

        // 诊断条目定义
        struct DiagItem
        {
            public string Id;        // 唯一标识
            public string Name;      // 显示名称
            public string FixLabel;  // 修复按钮文字（空 = 不可修复）
            public Func<bool> Check; // 诊断函数，返回 true = 正常
            public Action Fix;       // 修复操作
        }

        DiagItem[] items;

        public TroubleshootingForm()
        {
            Text = "故障检测与自动修复 | " + Program.DEV_NAME + " " + Program.APP_VERSION;
            Size = new Size(560, 620);
            MinimumSize = new Size(480, 500);
            StartPosition = FormStartPosition.CenterParent;
            FormBorderStyle = FormBorderStyle.Sizable;
            MaximizeBox = false;
            MinimizeBox = false;
            BackColor = Colors.Bg;
            ForeColor = Colors.Text;
            Font = new Font("Segoe UI", 10);
            ShowIcon = false;
            ShowInTaskbar = false;

            InitDiagItems();
            BuildUI();
            RunAllDiagnostics();
        }

        void InitDiagItems()
        {
            items = new DiagItem[] {
                new DiagItem {
                    Id = "node_env", Name = "Node.js 运行环境",
                    FixLabel = "重新检测",
                    Check = () => File.Exists(Path.Combine(Program.ROOT, "node", "node.exe")),
                    Fix = () => { }
                },
                new DiagItem {
                    Id = "port_3000", Name = "端口 3000 监听状态",
                    FixLabel = "启动服务器",
                    Check = () => Program.IsPortListening(3000),
                    Fix = () => {
                        Program.StartDashboardSilently();
                        System.Threading.Thread.Sleep(2000);
                        RunAllDiagnostics();
                    }
                },
                new DiagItem {
                    Id = "api_config", Name = "AI 配置完整性",
                    FixLabel = "打开配置",
                    Check = () => {
                        if (!File.Exists(Program.ENV_FILE)) return false;
                        string content = File.ReadAllText(Program.ENV_FILE);
                        return content.Contains("API_KEY") && !content.Contains("sk-你的");
                    },
                    Fix = () => {
                        // 直接在诊断窗口内打开配置，不依赖调用方
                        using (var cfg = new ConfigForm())
                        {
                            cfg.ShowDialog();
                        }
                        RunAllDiagnostics();
                    }
                },
                new DiagItem {
                    Id = "core_files", Name = "核心文件完整性",
                    FixLabel = "",
                    Check = () => {
                        string missing;
                        return Program.CoreFilesExist(out missing);
                    },
                    Fix = () => { }
                },
                new DiagItem {
                    Id = "zombie_nodes", Name = "残留 Node 进程",
                    FixLabel = "一键清理",
                    Check = () => Process.GetProcessesByName("node").Length <= 1,
                    Fix = () => {
                        Program.StopDashboardServer();
                        System.Threading.Thread.Sleep(500);
                        RunAllDiagnostics();
                    }
                },
                new DiagItem {
                    Id = "web_access", Name = "Web 端访问",
                    FixLabel = "重启服务器",
                    Check = () => {
                        try {
                            var req = WebRequest.Create("http://localhost:3000/");
                            req.Timeout = 3000;
                            using (var resp = req.GetResponse()) { return true; }
                        } catch { return false; }
                    },
                    Fix = () => {
                        Program.StopDashboardServer();
                        System.Threading.Thread.Sleep(1000);
                        Program.StartDashboardSilently();
                        System.Threading.Thread.Sleep(3000);
                        RunAllDiagnostics();
                    }
                },
                new DiagItem {
                    Id = "git_avail", Name = "Git 环境",
                    FixLabel = "",
                    Check = () => {
                        try {
                            string gitExe = Path.Combine(Program.ROOT, "PortableGit", "cmd", "git.exe");
                            if (!File.Exists(gitExe)) return false;
                            var psi = new ProcessStartInfo {
                                FileName = gitExe, Arguments = "--version",
                                UseShellExecute = false, CreateNoWindow = true,
                                RedirectStandardOutput = true
                            };
                            using (var p = Process.Start(psi)) { p.WaitForExit(); return p.ExitCode == 0; }
                        } catch { return false; }
                    },
                    Fix = () => { }
                },
                new DiagItem {
                    Id = "python_avail", Name = "Python 环境",
                    FixLabel = "",
                    Check = () => {
                        try {
                            var psi = new ProcessStartInfo {
                                FileName = "python", Arguments = "--version",
                                UseShellExecute = false, CreateNoWindow = true,
                                RedirectStandardOutput = true
                            };
                            using (var p = Process.Start(psi)) { p.WaitForExit(); return p.ExitCode == 0; }
                        } catch { return false; }
                    },
                    Fix = () => { }
                }
            };
        }

        void BuildUI()
        {
            int pad = 24;

            var header = new Label
            {
                Text = "🔧 故障检测与自动修复",
                Font = new Font("Segoe UI", 16, FontStyle.Bold),
                ForeColor = Colors.Text,
                Location = new Point(pad, 18),
                Size = new Size(520, 32)
            };
            var sub = new Label
            {
                Text = "一键诊断所有常见问题，支持自动修复",
                Font = new Font("Segoe UI", 9),
                ForeColor = Colors.TextDim,
                Location = new Point(pad, 50),
                Size = new Size(520, 20)
            };
            var div = new Panel
            {
                Location = new Point(pad, 78),
                Size = new Size(this.ClientSize.Width - pad * 2, 1),
                BackColor = Colors.Border,
                Anchor = AnchorStyles.Top | AnchorStyles.Left | AnchorStyles.Right
            };

            // 滚动面板
            itemsPanel = new Panel
            {
                Location = new Point(pad, 88),
                Size = new Size(this.ClientSize.Width - pad * 2, 370),
                AutoScroll = true,
                BackColor = Colors.Bg,
                Anchor = AnchorStyles.Top | AnchorStyles.Left | AnchorStyles.Right | AnchorStyles.Bottom
            };

            // 底部按钮
            var recheckBtn = new Button
            {
                Text = "重新检测",
                Location = new Point(pad, 470),
                Size = new Size(120, 36),
                FlatStyle = FlatStyle.Flat,
                BackColor = Colors.Accent,
                ForeColor = Color.White,
                Font = new Font("Segoe UI", 10, FontStyle.Bold),
                Cursor = Cursors.Hand,
                Anchor = AnchorStyles.Bottom | AnchorStyles.Left
            };
            recheckBtn.FlatAppearance.BorderSize = 0;
            recheckBtn.Click += (s, e) => RunAllDiagnostics();

            var closeBtn = new Button
            {
                Text = "关闭",
                Location = new Point(this.ClientSize.Width - pad - 100, 470),
                Size = new Size(100, 36),
                FlatStyle = FlatStyle.Flat,
                BackColor = Colors.Surface,
                ForeColor = Colors.Text,
                Cursor = Cursors.Hand,
                Anchor = AnchorStyles.Bottom | AnchorStyles.Right
            };
            closeBtn.FlatAppearance.BorderColor = Colors.Border;
            closeBtn.FlatAppearance.BorderSize = 1;
            closeBtn.Click += (s, e) => this.Close();

 Controls.AddRange(new Control[] { header, sub, div, itemsPanel, recheckBtn, closeBtn });
        }

        void RunAllDiagnostics()
        {
            itemsPanel.Controls.Clear();
            resultLabels.Clear();
            fixButtons.Clear();

            int y = 10;
            int panelW = itemsPanel.ClientSize.Width - 20;
            int itemH = 48;

            foreach (var item in items)
            {
                bool ok = false;
                try { ok = item.Check(); } catch { }

                // 颜色和图标
                Color statusColor = ok ? Colors.Green : Colors.Red;
                string icon = ok ? "✓" : "✗";

                // 状态图标 + 名称（注意：这些是 card 的子控件，坐标相对于 card）
                var statusIcon = new Label
                {
                    Text = icon,
                    Font = new Font("Segoe UI", 12, FontStyle.Bold),
                    ForeColor = statusColor,
                    Location = new Point(10, 4),
                    Size = new Size(24, 24),
                    TextAlign = ContentAlignment.MiddleCenter,
                    BackColor = Color.Transparent
                };
                var nameLabel = new Label
                {
                    Text = item.Name,
                    Font = new Font("Segoe UI", 10, FontStyle.Bold),
                    ForeColor = Colors.Text,
                    Location = new Point(40, 4),
                    Size = new Size(panelW - 180, 22),
                    BackColor = Color.Transparent
                };

                // 背景卡片
                var card = new Panel
                {
                    Location = new Point(5, y),
                    Size = new Size(panelW, itemH),
                    BackColor = Colors.Surface
                };
                card.Paint += (s, e) => {
                    var rect = new Rectangle(0, 0, card.Width - 1, card.Height - 1);
                    using (var path = RoundedRect(rect, 8))
                    using (var brush = new SolidBrush(card.BackColor))
                    using (var pen = new Pen(Colors.Border, 1))
                    {
                        e.Graphics.SmoothingMode = SmoothingMode.AntiAlias;
                        e.Graphics.FillPath(brush, path);
                        e.Graphics.DrawPath(pen, path);
                    }
                };

                // 修复按钮
                if (!string.IsNullOrEmpty(item.FixLabel) && !ok)
                {
                    var fixBtn = new Button
                    {
                        Text = item.FixLabel,
                        Location = new Point(panelW - 120, 8),
                        Size = new Size(110, 30),
                        FlatStyle = FlatStyle.Flat,
                        BackColor = Colors.Accent,
                        ForeColor = Color.White,
                        Font = new Font("Segoe UI", 9, FontStyle.Bold),
                        Cursor = Cursors.Hand
                    };
                    fixBtn.FlatAppearance.BorderSize = 0;
                    fixBtn.Click += (s, e) => {
                        try { item.Fix(); } catch (Exception ex) {
                            MessageBox.Show("修复失败: " + ex.Message, "错误",
                                MessageBoxButtons.OK, MessageBoxIcon.Error);
                        }
                    };
                    fixButtons[item.Id] = fixBtn;
                    card.Controls.Add(fixBtn);
                }

                card.Controls.Add(statusIcon);
                card.Controls.Add(nameLabel);
                resultLabels[item.Id] = nameLabel;
                itemsPanel.Controls.Add(card);

                y += itemH + 8;
            }

 // 更新一下可用性
            this.Invalidate();
        }

        static GraphicsPath RoundedRect(Rectangle r, int radius)
        {
            var path = new GraphicsPath();
            int d = radius * 2;
            path.AddLine(r.X + radius, r.Y, r.Right - radius, r.Y);
            path.AddArc(r.Right - d, r.Y, d, d, 270, 90);
            path.AddLine(r.Right, r.Y + radius, r.Right, r.Bottom - radius);
            path.AddArc(r.Right - d, r.Bottom - d, d, d, 0, 90);
            path.AddLine(r.Right - radius, r.Bottom, r.X + radius, r.Bottom);
            path.AddArc(r.X, r.Bottom - d, d, d, 90, 90);
            path.AddLine(r.X, r.Bottom - radius, r.X, r.Y + radius);
            path.AddArc(r.X, r.Y, d, d, 180, 90);
            path.CloseFigure();
            return path;
        }
    }

    // API 配置窗口
    class ConfigForm : Form
    {
        public bool Saved { get; private set; }

        ComboBox providerBox;
        TextBox keyBox;
        TextBox urlBox;
        TextBox modelBox;
        Label statusLabel;
        Timer statusTimer;

        struct ProviderInfo
        {
            public string Label;
            public string ConfigProvider;
            public string BaseUrl;          // 网页版用的 API 地址
            public string Model;
            public string EnvKey;
            public bool NeedsProxy;         // true=终端必须走代理, false=终端可直连
            public string AnthropicUrl;     // 终端直连的 Anthropic 兼容地址（NeedsProxy=false 时有效）
        }

        ProviderInfo[] providers = new ProviderInfo[] {
            new ProviderInfo { Label = "DeepSeek", ConfigProvider = "openai", BaseUrl = "https://api.deepseek.com/v1", Model = "deepseek-v4-pro", EnvKey = "OPENAI_API_KEY", NeedsProxy = false, AnthropicUrl = "https://api.deepseek.com/anthropic" },
            new ProviderInfo { Label = "OpenAI（自动代理）", ConfigProvider = "openai", BaseUrl = "https://api.openai.com/v1", Model = "gpt-4o", EnvKey = "OPENAI_API_KEY", NeedsProxy = true },
            new ProviderInfo { Label = "Claude (Anthropic)", ConfigProvider = "anthropic", BaseUrl = "", Model = "claude-sonnet-4-6", EnvKey = "ANTHROPIC_API_KEY", NeedsProxy = false, AnthropicUrl = "https://api.anthropic.com" },
            new ProviderInfo { Label = "Gemini（自动代理）", ConfigProvider = "gemini", BaseUrl = "https://generativelanguage.googleapis.com/v1beta", Model = "gemini-2.5-flash", EnvKey = "GEMINI_API_KEY", NeedsProxy = true },
            new ProviderInfo { Label = "OpenRouter", ConfigProvider = "openrouter", BaseUrl = "", Model = "auto", EnvKey = "OPENROUTER_API_KEY", NeedsProxy = false, AnthropicUrl = "https://openrouter.ai/api" },
        };

        public ConfigForm()
        {
            Text = "配置 API 密钥 | " + Program.DEV_NAME + " " + Program.APP_VERSION;
            Size = new Size(520, 490);
            MinimumSize = new Size(480, 400);
            StartPosition = FormStartPosition.CenterParent;
            FormBorderStyle = FormBorderStyle.Sizable;
            MaximizeBox = false;
            MinimizeBox = false;
            BackColor = Colors.Bg;
            ForeColor = Colors.Text;
            Font = new Font("Segoe UI", 10);
            ShowIcon = false;
            ShowInTaskbar = false;

            BuildForm();
            LoadCurrentConfig();
        }

        void BuildForm()
        {
            var header = new Label
            {
                Text = "🔑 配置 API 密钥",
                Font = new Font("Segoe UI", 16, FontStyle.Bold),
                ForeColor = Colors.Text,
                Location = new Point(24, 18),
                Size = new Size(420, 32)
            };

            var sub = new Label
            {
                Text = "一次配置，同时生效到网页版和终端",
                Font = new Font("Segoe UI", 9),
                ForeColor = Colors.TextDim,
                Location = new Point(24, 50),
                Size = new Size(420, 20)
            };

            var lbl1 = new Label { Text = "AI 提供商", Location = new Point(24, 84), Size = new Size(420, 18), ForeColor = Colors.TextDim, Font = new Font("Segoe UI", 9) };
            providerBox = new ComboBox
            {
                Location = new Point(24, 104),
                Size = new Size(420, 28),
                DropDownStyle = ComboBoxStyle.DropDownList,
                BackColor = Colors.Surface,
                ForeColor = Colors.Text,
                FlatStyle = FlatStyle.Flat,
                Font = new Font("Segoe UI", 10),
                Anchor = AnchorStyles.Top | AnchorStyles.Left | AnchorStyles.Right
            };
            providerBox.DropDownWidth = 400;
            foreach (var p in providers) providerBox.Items.Add(p.Label);
            providerBox.SelectedIndexChanged += OnProviderChanged;

            var lbl2 = new Label { Text = "API 密钥", Location = new Point(24, 142), Size = new Size(420, 18), ForeColor = Colors.TextDim, Font = new Font("Segoe UI", 9) };
            keyBox = new TextBox
            {
                Location = new Point(24, 162),
                Size = new Size(420, 24),
                BackColor = Colors.Surface,
                ForeColor = Colors.Text,
                BorderStyle = BorderStyle.FixedSingle,
                Font = new Font("Segoe UI", 10),
                UseSystemPasswordChar = true,
                Anchor = AnchorStyles.Top | AnchorStyles.Left | AnchorStyles.Right
            };

            var lbl3 = new Label { Text = "接口地址（自动填充）", Location = new Point(24, 200), Size = new Size(420, 18), ForeColor = Colors.TextDim, Font = new Font("Segoe UI", 9) };
            urlBox = new TextBox
            {
                Location = new Point(24, 220),
                Size = new Size(420, 24),
                BackColor = Colors.Surface,
                ForeColor = Colors.Text,
                BorderStyle = BorderStyle.FixedSingle,
                Font = new Font("Segoe UI", 10),
                Anchor = AnchorStyles.Top | AnchorStyles.Left | AnchorStyles.Right
            };

            var lbl4 = new Label { Text = "模型（自动填充）", Location = new Point(24, 258), Size = new Size(420, 18), ForeColor = Colors.TextDim, Font = new Font("Segoe UI", 9) };
            modelBox = new TextBox
            {
                Location = new Point(24, 278),
                Size = new Size(420, 24),
                BackColor = Colors.Surface,
                ForeColor = Colors.Text,
                BorderStyle = BorderStyle.FixedSingle,
                Font = new Font("Segoe UI", 10),
                Anchor = AnchorStyles.Top | AnchorStyles.Left | AnchorStyles.Right
            };

            var noteLabel = new Label
            {
                Text = "💡 网页端 Setup 支持更多供应商（Ollama / 自定义 API 等），带自动拉取模型列表",
                Font = new Font("Segoe UI", 8),
                ForeColor = Colors.TextDim,
                Location = new Point(24, 356),
                Size = new Size(420, 18),
                TextAlign = ContentAlignment.MiddleLeft,
                Anchor = AnchorStyles.Bottom | AnchorStyles.Left | AnchorStyles.Right
            };

            var saveBtn = new Button
            {
                Text = "保存配置",
                Location = new Point(24, 316),
                Size = new Size(420, 36),
                FlatStyle = FlatStyle.Flat,
                BackColor = Colors.Accent,
                ForeColor = Color.White,
                Font = new Font("Segoe UI", 10, FontStyle.Bold),
                Cursor = Cursors.Hand,
                Anchor = AnchorStyles.Bottom | AnchorStyles.Left | AnchorStyles.Right
            };
            saveBtn.FlatAppearance.BorderSize = 0;
            using (var path = RoundedRect(new Rectangle(0, 0, saveBtn.Width, saveBtn.Height), 8))
                saveBtn.Region = new Region(path);
            saveBtn.MouseEnter += (s, e) => saveBtn.BackColor = Colors.AccentDark;
            saveBtn.MouseLeave += (s, e) => saveBtn.BackColor = Colors.Accent;
            saveBtn.Click += OnSave;

            statusLabel = new Label
            {
                Text = "",
                Font = new Font("Segoe UI", 9, FontStyle.Bold),
                ForeColor = Colors.Green,
                Location = new Point(24, 380),
                Size = new Size(420, 24),
                TextAlign = ContentAlignment.MiddleCenter,
                Visible = false,
                Anchor = AnchorStyles.Bottom | AnchorStyles.Left | AnchorStyles.Right
            };

            Controls.AddRange(new Control[] { header, sub, lbl1, providerBox, lbl2, keyBox, lbl3, urlBox, lbl4, modelBox, saveBtn, noteLabel, statusLabel });

            providerBox.DrawMode = DrawMode.OwnerDrawFixed;
            providerBox.DrawItem += (s, e) => {
                e.DrawBackground();
                var col = (e.State & DrawItemState.Selected) == DrawItemState.Selected ? Colors.Accent : Colors.Text;
                using (var brush = new SolidBrush(col))
                {
                    e.Graphics.DrawString(providerBox.Items[e.Index].ToString(), e.Font, brush, e.Bounds);
                }
            };

            providerBox.SelectedIndex = 0;
        }

        void OnProviderChanged(object s, EventArgs e)
        {
            int idx = providerBox.SelectedIndex;
            if (idx < 0) return;
            var p = providers[idx];
            urlBox.Text = p.BaseUrl;
            modelBox.Text = p.Model;
            keyBox.Text = "";
            keyBox.Focus();
        }

        void LoadCurrentConfig()
        {
            try
            {
                var cfg = new Dictionary<string, string>();
                if (File.Exists(Program.ENV_FILE))
                {
                    foreach (var line in File.ReadAllLines(Program.ENV_FILE))
                    {
                        var t = line.Trim();
                        if (t == "" || t.StartsWith("#")) continue;
                        int eq = t.IndexOf('=');
                        if (eq < 0) continue;
                        cfg[t.Substring(0, eq).Trim()] = t.Substring(eq + 1).Trim();
                    }
                }
                if (!cfg.ContainsKey("AI_PROVIDER")) return;
                string prov = cfg["AI_PROVIDER"];
                if (prov == "openai" && cfg.ContainsKey("OPENAI_API_KEY") && cfg["OPENAI_API_KEY"] != "")
                {
                    string url = cfg.ContainsKey("OPENAI_BASE_URL") ? cfg["OPENAI_BASE_URL"] : "";
                    bool isDeepSeek = url.Contains("deepseek");
                    for (int i = 0; i < providers.Length; i++)
                    {
                        if (isDeepSeek && providers[i].Label == "DeepSeek") { SelectProvider(i, cfg); return; }
                        if (!isDeepSeek && providers[i].Label == "OpenAI（自动代理）") { SelectProvider(i, cfg); return; }
                    }
                }
                else if (prov == "anthropic" && cfg.ContainsKey("ANTHROPIC_API_KEY") && cfg["ANTHROPIC_API_KEY"] != "")
                {
                    for (int i = 0; i < providers.Length; i++)
                        if (providers[i].Label == "Claude (Anthropic)") { SelectProvider(i, cfg); return; }
                }
                else if (prov == "gemini" && cfg.ContainsKey("GEMINI_API_KEY") && cfg["GEMINI_API_KEY"] != "")
                {
                    for (int i = 0; i < providers.Length; i++)
                        if (providers[i].Label == "Gemini（自动代理）") { SelectProvider(i, cfg); return; }
                }
                else if (prov == "openrouter" && cfg.ContainsKey("OPENROUTER_API_KEY") && cfg["OPENROUTER_API_KEY"] != "")
                {
                    for (int i = 0; i < providers.Length; i++)
                        if (providers[i].Label == "OpenRouter") { SelectProvider(i, cfg); return; }
                }
            }
            catch { }
        }

        void SelectProvider(int idx, Dictionary<string, string> cfg)
        {
            providerBox.SelectedIndex = idx;
            var p = providers[idx];
            keyBox.Text = cfg.ContainsKey(p.EnvKey) ? cfg[p.EnvKey] : "";
            urlBox.Text = cfg.ContainsKey(p.EnvKey.Replace("API_KEY", "BASE_URL")) ? cfg[p.EnvKey.Replace("API_KEY", "BASE_URL")] : p.BaseUrl;
            modelBox.Text = cfg.ContainsKey(p.EnvKey.Replace("API_KEY", "MODEL")) ? cfg[p.EnvKey.Replace("API_KEY", "MODEL")] : p.Model;
        }

        void OnSave(object s, EventArgs e)
        {
            int idx = providerBox.SelectedIndex;
            if (idx < 0) return;
            var p = providers[idx];
            string key = keyBox.Text.Trim();

            if (key == "")
            {
                ShowStatus("请输入 API 密钥", Color.FromArgb(239, 68, 68));
                return;
            }

            try
            {
                if (!Directory.Exists(Program.DATA_DIR))
                    Directory.CreateDirectory(Program.DATA_DIR);

                var lines = new List<string>();
                lines.Add("# ========================================================");
                lines.Add("# Portable AI - " + p.Label + " Configuration");
                lines.Add("# ========================================================");
                lines.Add("AI_PROVIDER=" + p.ConfigProvider);
                if (urlBox.Text.Trim() != "")
                    lines.Add(p.EnvKey.Replace("API_KEY", "BASE_URL") + "=" + urlBox.Text.Trim());
                lines.Add(p.EnvKey + "=" + key);
                lines.Add(p.EnvKey.Replace("API_KEY", "MODEL") + "=" + modelBox.Text.Trim());
                lines.Add("AI_DISPLAY_MODEL=" + modelBox.Text.Trim());
                File.WriteAllLines(Program.ENV_FILE, lines.ToArray());

                // 写 .claude/settings.json：直连供应商直接填 Anthropic 兼容地址，不兼容的走代理
                if (p.NeedsProxy)
                {
                    Program.WriteClaudeSettings(modelBox.Text.Trim(), key);
                }
                else
                {
                    Program.WriteClaudeSettingsDirect(modelBox.Text.Trim(), key, p.AnthropicUrl);
                }

                Saved = true;
                ShowStatus("正在验证 API...", Color.FromArgb(128, 136, 158));

                System.Threading.Tasks.Task.Factory.StartNew(delegate()
                {
                    string msg;
                    Color clr;
                    try
                    {
                        string verifyUrl = urlBox.Text.Trim();
                        if (verifyUrl == "") verifyUrl = p.BaseUrl;
                        if (p.Label == "Gemini（自动代理）")
                        {
                            string geminiUrl = (verifyUrl != "" ? verifyUrl : "https://generativelanguage.googleapis.com/v1beta")
                                + "/models?key=" + key;
                            var req = WebRequest.Create(geminiUrl);
                            req.Timeout = 6000;
                            using (var resp = req.GetResponse()) { }
                        }
                        else if (p.Label == "Claude (Anthropic)")
                        {
                            string claudeUrl = (verifyUrl != "" ? verifyUrl : "https://api.anthropic.com/v1") + "/models";
                            var req = WebRequest.Create(claudeUrl);
                            req.Headers["x-api-key"] = key;
                            req.Headers["anthropic-version"] = "2023-06-01";
                            req.Timeout = 6000;
                            using (var resp = req.GetResponse()) { }
                        }
                        else if (verifyUrl != "")
                        {
                            if (!verifyUrl.EndsWith("/")) verifyUrl += "/";
                            var req = WebRequest.Create(verifyUrl + "models");
                            req.Headers["Authorization"] = "Bearer " + key;
                            req.Timeout = 6000;
                            using (var resp = req.GetResponse()) { }
                        }
                        msg = "✓ 配置已保存，API 验证通过";
                        clr = Colors.Green;
                    }
                    catch (Exception ex)
                    {
                        msg = "✗ 配置已保存，但 API 验证失败：" + ex.Message;
                        clr = Color.FromArgb(239, 68, 68);
                    }
                    this.Invoke(new Action(delegate() { ShowStatus(msg, clr); }));
                });
            }
            catch (Exception ex)
            {
                ShowStatus("✗ 保存失败: " + ex.Message, Color.FromArgb(239, 68, 68));
            }
        }

        void ShowStatus(string msg, Color color)
        {
            statusLabel.Text = msg;
            statusLabel.ForeColor = color;
            statusLabel.Visible = true;
            if (statusTimer != null) { statusTimer.Stop(); statusTimer.Dispose(); }
            statusTimer = new Timer { Interval = 6000 };
            statusTimer.Tick += (s, e) => {
                statusLabel.Visible = false;
                statusTimer.Stop();
                statusTimer.Dispose();
                statusTimer = null;
            };
            statusTimer.Start();
        }

        static GraphicsPath RoundedRect(Rectangle r, int radius)
        {
            var path = new GraphicsPath();
            int d = radius * 2;
            path.AddLine(r.X + radius, r.Y, r.Right - radius, r.Y);
            path.AddArc(r.Right - d, r.Y, d, d, 270, 90);
            path.AddLine(r.Right, r.Y + radius, r.Right, r.Bottom - radius);
            path.AddArc(r.Right - d, r.Bottom - d, d, d, 0, 90);
            path.AddLine(r.Right - radius, r.Bottom, r.X + radius, r.Bottom);
            path.AddArc(r.X, r.Bottom - d, d, d, 90, 90);
            path.AddLine(r.X, r.Bottom - radius, r.X, r.Y + radius);
            path.AddArc(r.X, r.Y, d, d, 180, 90);
            path.CloseFigure();
            return path;
        }

        protected override void OnPaint(PaintEventArgs e)
        {
            base.OnPaint(e);
            using (var brush = new LinearGradientBrush(
                new Point(0, 0), new Point(Width, 0),
                Colors.Accent, Color.FromArgb(30, Colors.Accent)))
            using (var pen = new Pen(brush, 2))
            {
                e.Graphics.DrawLine(pen, 0, 0, Width, 0);
            }
        }
    }
}
