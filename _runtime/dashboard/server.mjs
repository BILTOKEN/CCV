import { createServer } from 'http';
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync, mkdirSync, unlinkSync, renameSync } from 'fs';
import { join, dirname, resolve, relative, isAbsolute, sep } from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
import { execSync, exec } from 'child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const require_mod = createRequire(import.meta.url);
const iconv = require_mod('iconv-lite');
const ROOT_DIR = join(__dirname, '..'); // Portable_AI_USB root
const DATA_DIR = join(ROOT_DIR, 'data');
const ENV_FILE = join(DATA_DIR, 'ai_settings.env');
const CHATS_DIR = join(DATA_DIR, 'chats');
const HTML_FILE = join(__dirname, 'index.html');
const IS_WIN = process.platform === 'win32';
const IS_MAC = process.platform === 'darwin';
// Auto-detect platform engine directory
const PLATFORM_DIR = IS_WIN ? 'win' : IS_MAC ? 'darwin' : 'linux';
const ARCH_DIR = process.arch === 'x64' || process.arch === 'amd64' ? 'x64' : 'arm64';
const BIN_DIR = join(ROOT_DIR, 'engine', `node-${PLATFORM_DIR}-${ARCH_DIR}`, 'bin');
const PORT = 3000;
const MAX_CHATS = 20;
let WORK_DIR = join(ROOT_DIR, '..'); // 指向 _runtime 的父目录（用户工作区）

// ─── Helpers ─────────────────────────────────────────────────

function readConfig() {
    if (!existsSync(ENV_FILE)) return {};
    const raw = readFileSync(ENV_FILE, 'utf-8');
    const config = {};
    for (const line of raw.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const idx = trimmed.indexOf('=');
        if (idx === -1) continue;
        config[trimmed.slice(0, idx).trim()] = trimmed.slice(idx + 1).trim();
    }
    return config;
}

function writeConfig(config) {
    if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
    const lines = ['# ========================================================', '# Portable AI - Master Switchboard', '# ========================================================'];
    for (const [key, value] of Object.entries(config)) lines.push(`${key}=${value}`);
    writeFileSync(ENV_FILE, lines.join('\n') + '\n', 'utf-8');
}

function readBody(req) {
    return new Promise((resolve, reject) => {
        let data = '';
        req.on('data', chunk => data += chunk);
        req.on('end', () => { try { resolve(JSON.parse(data)); } catch { reject(new Error('Invalid JSON')); } });
    });
}

function readBodyRaw(req) {
    return new Promise(resolve => {
        let data = '';
        req.on('data', chunk => data += chunk);
        req.on('end', () => resolve(data));
    });
}

async function fetchHTML(url, extraHeaders = {}) {
    const mod = await import(url.startsWith('https') ? 'https' : 'http');
    const headers = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36', 'Accept': 'text/html,application/xhtml+xml', 'Accept-Language': 'zh-CN,zh;q=0.9', ...extraHeaders };
    const options = { headers };
    return new Promise((resolve, reject) => {
        const req = mod.get(url, options, res => {
            // Handle redirects (302)
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                const redirectUrl = res.headers.location.startsWith('/')
                    ? new URL(url).origin + res.headers.location
                    : res.headers.location;
                fetchHTML(redirectUrl, extraHeaders).then(resolve).catch(reject);
                return;
            }
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => resolve(data));
        });
        req.on('error', reject);
        req.setTimeout(15000, () => { req.destroy(); reject(new Error('Timeout')); });
        req.end();
    });
}

async function fetchExternal(url, headers = {}, body = null, method = 'GET', redirectCount = 0) {
    if (redirectCount > 5) throw new Error('Too many redirects');
    const mod = await import(url.startsWith('https') ? 'https' : 'http');
    const defaultHeaders = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.5',
        ...headers
    };
    return new Promise((resolve, reject) => {
        const opts = { method, headers: defaultHeaders };
        if (url.startsWith('https')) opts.rejectUnauthorized = false; // 允许自签/过期证书
        const req = mod.request(url, opts, res => {
            if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
                const redirectUrl = res.headers.location.startsWith('http')
                    ? res.headers.location
                    : new URL(res.headers.location, url).href;
                fetchExternal(redirectUrl, headers, body, method, redirectCount + 1).then(resolve).catch(reject);
                return;
            }
            const chunks = [];
            res.on('data', chunk => chunks.push(chunk));
            res.on('end', () => {
                const buf = Buffer.concat(chunks);
                // 从 Content-Type 提取 charset
                const ct = (res.headers['content-type'] || '').toLowerCase();
                const cm = ct.match(/charset=([^;]+)/);
                let charset = (cm ? cm[1].trim().toLowerCase() : '');
                // 没声明则查 HTML meta 标签
                if (!charset) {
                    const head = buf.slice(0, 1024).toString('utf8').toLowerCase();
                    const mm = head.match(/charset[="\s]+([^"\s;>]+)/i);
                    if (mm) charset = mm[1].toLowerCase();
                }
                // 用 iconv-lite 解码非 UTF-8 内容
                let data;
                if (charset && charset !== 'utf-8' && charset !== 'utf8') {
                    try { data = iconv.decode(buf, charset); } catch { data = buf.toString('utf8'); }
                } else {
                    data = buf.toString('utf8');
                }
                resolve({ status: res.statusCode, data, headers: res.headers });
            });
        });
        req.on('error', reject);
        req.setTimeout(30000, () => { req.destroy(); reject(new Error('Timeout')); });
        if (body) req.write(body);
        req.end();
    });
}

async function streamExternal(url, headers, body, onChunk, onEnd) {
    const mod = await import(url.startsWith('https') ? 'https' : 'http');
    return new Promise((resolve, reject) => {
        const req = mod.request(url, { method: 'POST', headers }, res => {
            res.on('data', chunk => onChunk(chunk.toString()));
            res.on('end', () => { onEnd(); resolve(); });
            res.on('error', reject);
        });
        req.on('error', reject);
        req.setTimeout(180000, () => { req.destroy(); reject(new Error('Timeout')); });
        req.write(body);
        req.end();
    });
}

function sendJSON(res, status, obj) {
    res.writeHead(status, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify(obj));
}

function getInstalledVersion() {
    // Check the engine directory for openclaude
    try {
        const pkg = join(ROOT_DIR, 'engine', 'node_modules', '@gitlawb', 'openclaude', 'package.json');
        if (existsSync(pkg)) return JSON.parse(readFileSync(pkg, 'utf-8')).version;
    } catch {}
    return null;
}

function getLatestVersion() {
    try {
        return execSync('npm view @gitlawb/openclaude version', { encoding: 'utf-8', timeout: 10000 }).trim();
    } catch { return null; }
}

function getSystemInfo() {
    const whichCmd = IS_WIN ? 'where' : 'which';
    const info = {
        nodeVersion: process.version, platform: process.platform, arch: process.arch,
        hasGit: IS_WIN ? existsSync(join(BIN_DIR, 'git', 'cmd', 'git.exe')) || (() => { try { execSync('where git', { stdio: 'pipe' }); return true; } catch { return false; } })()
            : (() => { try { execSync('which git', { stdio: 'pipe' }); return true; } catch { return false; } })(),
        hasPython: IS_WIN ? existsSync(join(BIN_DIR, 'python', 'python.exe')) || (() => { try { execSync('where python', { stdio: 'pipe' }); return true; } catch { return false; } })()
            : (() => { try { execSync('which python3 || which python', { stdio: 'pipe' }); return true; } catch { return false; } })(),
        portableGit: IS_WIN && existsSync(join(BIN_DIR, 'git', 'cmd', 'git.exe')),
        portablePython: IS_WIN && existsSync(join(BIN_DIR, 'python', 'python.exe')),
        engineVersion: getInstalledVersion(),
        ollamaInstalled: existsSync(join(DATA_DIR, 'ollama', 'ollama.exe')) || existsSync(join(DATA_DIR, 'ollama', 'ollama')),
        diskFree: 0, diskTotal: 0,
    };
    try {
        if (IS_WIN) {
            const drive = ROOT_DIR.charAt(0);
            const out = execSync(`wmic logicaldisk where "DeviceID='${drive}:'" get FreeSpace,Size /format:csv`, { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] });
            const lines = out.trim().split('\n').filter(l => l.trim());
            const last = lines[lines.length - 1].split(',');
            info.diskFree = parseInt(last[1]) || 0;
            info.diskTotal = parseInt(last[2]) || 0;
        } else {
            const out = execSync(`df -k "${ROOT_DIR}" | tail -1`, { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] });
            const parts = out.trim().split(/\s+/);
            info.diskTotal = (parseInt(parts[1]) || 0) * 1024;
            info.diskFree = (parseInt(parts[3]) || 0) * 1024;
        }
    } catch {}
    return info;
}

function getSessionLogs() {
    const logsDir = join(DATA_DIR, 'app_data');
    const logs = [];
    if (!existsSync(logsDir)) return logs;
    function walkDir(dir, depth = 0) {
        if (depth > 3) return;
        try {
            for (const entry of readdirSync(dir)) {
                const fullPath = join(dir, entry);
                try {
                    const stat = statSync(fullPath);
                    if (stat.isDirectory()) walkDir(fullPath, depth + 1);
                    else if (['.json','.log','.md','.txt'].some(ext => entry.endsWith(ext)))
                        logs.push({ name: entry, path: fullPath.replace(ROOT_DIR, ''), size: stat.size, modified: stat.mtime.toISOString() });
                } catch {}
            }
        } catch {}
    }
    walkDir(logsDir);
    return logs.sort((a, b) => new Date(b.modified) - new Date(a.modified)).slice(0, 50);
}

// ─── Chat History ─────────────────────────────────────────────

function ensureChatsDir() {
    if (!existsSync(CHATS_DIR)) mkdirSync(CHATS_DIR, { recursive: true });
}

function listChats() {
    ensureChatsDir();
    return readdirSync(CHATS_DIR)
        .filter(f => f.endsWith('.json'))
        .map(f => {
            const full = join(CHATS_DIR, f);
            try {
                const data = JSON.parse(readFileSync(full, 'utf-8'));
                return { id: f.replace('.json', ''), title: data.title || 'Untitled', created: data.created, updated: data.updated, messageCount: (data.messages || []).length };
            } catch { return null; }
        })
        .filter(Boolean)
        .sort((a, b) => new Date(b.updated) - new Date(a.updated));
}

function loadChat(id) {
    const file = join(CHATS_DIR, `${id}.json`);
    if (!existsSync(file)) return null;
    return JSON.parse(readFileSync(file, 'utf-8'));
}

function saveChat(id, data) {
    ensureChatsDir();
    writeFileSync(join(CHATS_DIR, `${id}.json`), JSON.stringify(data, null, 2), 'utf-8');
}

function deleteChat(id) {
    const file = join(CHATS_DIR, `${id}.json`);
    if (existsSync(file)) { unlinkSync(file); }
}

function autoCleanupChats() {
    const files = readdirSync(CHATS_DIR)
        .filter(f => f.endsWith('.json'))
        .map(f => {
            const full = join(CHATS_DIR, f);
            try {
                const data = JSON.parse(readFileSync(full, 'utf-8'));
                return { id: f.replace('.json', ''), updated: data.updated || '' };
            } catch { return null; }
        })
        .filter(Boolean)
        .sort((a, b) => new Date(b.updated) - new Date(a.updated));
    const cleaned = [];
    while (files.length > MAX_CHATS) {
        const oldest = files.pop();
        deleteChat(oldest.id);
        cleaned.push(oldest.id);
    }
    return cleaned;
}

function newChatId() {
    return `chat_${Date.now()}`;
}

// ═══════════════════════════════════════════════════════════════
//  AGENT SYSTEM — Tool Definitions, Executors, and Agentic Loop
// ═══════════════════════════════════════════════════════════════

// ─── Tool Definitions ────────────────────────────────────────

const TOOL_DEFS = [
    {
        name: 'write_file', description: '写纯文本文件（支持 .md/.js/.py/.html/.css/.json/.txt/.bat/.sh/.yml/.yaml/.toml/.ini/.env/.gitignore 等格式）。要生成 .docx/.xlsx/.pptx 文档请使用 generate_document 工具。',
        parameters: { type: 'object', properties: { path: { type: 'string', description: '文件路径' }, content: { type: 'string', description: '文件内容（纯文本）' } }, required: ['path', 'content'] }
    },
    {
        name: 'read_file', description: '读文件内容。大文件用 offset/limit 分段读取，超20000字自动截断',
        parameters: { type: 'object', properties: { path: { type: 'string', description: '文件路径' }, offset: { type: 'number', description: '起始行号（1-based，可选）' }, limit: { type: 'number', description: '读取行数（可选，默认全部）' } }, required: ['path'] }
    },
    {
        name: 'list_directory', description: '列出目录中的文件和子目录',
        parameters: { type: 'object', properties: { path: { type: 'string', description: '目录路径，"."表示当前' } }, required: ['path'] }
    },
    {
        name: 'execute_command', description: '执行终端命令并返回输出（超2000字截断）。用于脚本、编译、git等',
        parameters: { type: 'object', properties: { command: { type: 'string', description: '要执行的命令' } }, required: ['command'] }
    },
    {
        name: 'search_files', description: '在文件中搜索文本，返回匹配行',
        parameters: { type: 'object', properties: { pattern: { type: 'string', description: '搜索文本' }, path: { type: 'string', description: '搜索目录' } }, required: ['pattern', 'path'] }
    },
    {
        name: 'edit_file', description: '精确替换文件中的文本（手术刀式修改）',
        parameters: { type: 'object', properties: { path: { type: 'string', description: '文件路径' }, old_text: { type: 'string', description: '要替换的原文本' }, new_text: { type: 'string', description: '新文本' } }, required: ['path', 'old_text', 'new_text'] }
    },
    {
        name: 'glob', description: '用通配符匹配文件，如 "**/*.js"',
        parameters: { type: 'object', properties: { pattern: { type: 'string', description: 'Glob模式' }, path: { type: 'string', description: '搜索目录' } }, required: ['pattern'] }
    },
    {
        name: 'grep', description: '用正则表达式搜索文件内容',
        parameters: { type: 'object', properties: { pattern: { type: 'string', description: '正则表达式' }, path: { type: 'string', description: '搜索目录' }, glob: { type: 'string', description: '文件过滤' } }, required: ['pattern'] }
    },
    {
        name: 'git_status', description: '查看git工作树状态',
        parameters: { type: 'object', properties: { path: { type: 'string', description: '仓库路径' } } }
    },
    {
        name: 'git_diff', description: '查看git改动',
        parameters: { type: 'object', properties: { path: { type: 'string', description: '文件路径' }, staged: { type: 'boolean', description: '查看暂存区' } } }
    },
    {
        name: 'git_commit', description: '创建git提交',
        parameters: { type: 'object', properties: { message: { type: 'string', description: '提交信息' } }, required: ['message'] }
    },
    {
        name: 'move_file', description: '移动或重命名文件/目录',
        parameters: { type: 'object', properties: { source: { type: 'string', description: '源路径' }, dest: { type: 'string', description: '目标路径' } }, required: ['source', 'dest'] }
    },
    {
        name: 'delete_file', description: '删除文件，慎用',
        parameters: { type: 'object', properties: { path: { type: 'string', description: '文件路径' } }, required: ['path'] }
    },
    {
        name: 'web_search', description: '搜索网页，返回标题+链接+摘要（不是全文！）。同一话题最多搜2次，搜完必须 web_fetch 打开链接',
        parameters: { type: 'object', properties: { query: { type: 'string', description: '搜索关键词' } }, required: ['query'] }
    },
    {
        name: 'web_fetch', description: '抓取网页全文（超4000字截断）。拿到内容后才能回答或生成文档，禁止凭摘要编造',
        parameters: { type: 'object', properties: { url: { type: 'string', description: '网页完整URL' } }, required: ['url'] }
    },
    {
        name: 'generate_document', description: '【优先使用】生成 Office 文档（.docx/.xlsx/.pptx）。用户要 Word/PPT/Excel 时必须用此工具，不要装包跑 Python 脚本。内容用 Markdown（#标题、|表格、**粗体**）。网络资料需先 web_fetch，用户直接给的文字直接生成。',
        parameters: { type: 'object', properties: {
            path: { type: 'string', description: '输出路径，以 .docx/.xlsx/.pptx 结尾' },
            content: { type: 'string', description: 'markdown 内容（支持 # 标题、| 表格、**粗体**）' },
            basedOnWebContent: { type: 'boolean', description: '是否基于网页内容生成，默认 false' }
        }, required: ['path', 'content'] }
    }
];

// 工具名中英文映射
const TOOL_LABELS = {
    write_file: '写文件', read_file: '读文件', list_directory: '列目录',
    execute_command: '执行命令', search_files: '搜索文件', edit_file: '编辑文件',
    glob: 'Glob匹配', grep: 'Grep搜索', git_status: 'Git状态', git_diff: 'Git差异',
    git_commit: 'Git提交', move_file: '移动文件', delete_file: '删除文件',
    web_search: '网页搜索', web_fetch: '抓取网页', generate_document: '生成文档'
};

// Provider-specific tool format converters
function toolsForOpenAI() {
    return TOOL_DEFS.map(t => ({
        type: 'function',
        function: { name: t.name, description: t.description, parameters: t.parameters }
    }));
}

function toolsForAnthropic() {
    return TOOL_DEFS.map(t => ({
        name: t.name, description: t.description, input_schema: t.parameters
    }));
}

function toolsForGemini() {
    return [{ function_declarations: TOOL_DEFS.map(t => ({
        name: t.name, description: t.description, parameters: t.parameters
    })) }];
}

// ─── Tool Executors ──────────────────────────────────────────

function resolvePath(relPath, options = {}) {
    const abs = isAbsolute(relPath) ? relPath : join(WORK_DIR, relPath);
    const resolved = resolve(abs);
    // 沙箱：不允许逃出工作目录
    const workspaceRoot = resolve(WORK_DIR);
    if (!resolved.startsWith(workspaceRoot + sep) && resolved !== workspaceRoot) {
        // 已审批放行或同次会话已缓存
        if (options.skipCheck) return resolved;
        if (runAgent._approvedPaths) {
            // 检查是否已有已审批的父目录匹配
            for (const approved of runAgent._approvedPaths) {
                if (resolved.startsWith(approved + sep) || resolved === approved) return resolved;
            }
        }
        // 抛特殊错误，让上层弹审批窗
        throw Object.assign(new Error(`访问被拒绝: ${relPath} 在工作目录外`), {
            code: 'E_NEED_PATH_APPROVAL',
            requestedPath: resolved,
            originalArg: relPath
        });
    }
    return resolved;
}

const WRITE_TOOLS = new Set(['write_file', 'edit_file', 'move_file', 'delete_file', 'execute_command', 'git_commit', 'generate_document']);
const READ_TOOLS = new Set(['read_file', 'glob', 'grep', 'list_directory', 'search_files', 'git_status', 'git_diff', 'web_search', 'web_fetch']);

// ─── Document Generation (docx/xlsx/pptx) ────────────────────

const _require = createRequire(import.meta.url);

async function generateDocument(filePath, content) {
    const ext = filePath.toLowerCase().slice(filePath.lastIndexOf('.'));
    if (!['.docx', '.xlsx', '.pptx'].includes(ext)) {
        return { success: false, error: `不支持的格式: ${ext}，仅支持 .docx/.xlsx/.pptx` };
    }
    try {
        if (ext === '.docx') {
            const { Document: DocxDocument, Packer, Paragraph, TextRun, HeadingLevel, Table, TableRow, TableCell, WidthType, AlignmentType } = _require('docx');
            const lines = content.split('\n');
            const children = [];
            for (let i = 0; i < lines.length; i++) {
                const t = lines[i].trim();
                if (!t) { children.push(new Paragraph({ spacing: { after: 200 } })); continue; }
                const hm = t.match(/^(#{1,6})\s+(.+)/);
                if (hm) {
                    const lv = hm[1].length;
                    const m = {1: HeadingLevel.HEADING_1, 2: HeadingLevel.HEADING_2, 3: HeadingLevel.HEADING_3, 4: HeadingLevel.HEADING_4, 5: HeadingLevel.HEADING_5, 6: HeadingLevel.HEADING_6};
                    children.push(new Paragraph({ text: hm[2], heading: m[lv], spacing: { before: 400, after: 200 } }));
                    continue;
                }
                // Table
                if (t.startsWith('|') && t.endsWith('|') && i + 1 < lines.length && lines[i+1].trim().startsWith('|')) {
                    const rows = [];
                    while (i < lines.length) { const l = lines[i].trim(); if (l.startsWith('|') && l.endsWith('|')) { rows.push(l); i++; } else break; }
                    i--;
                    const hasSep = rows.length > 1 && /^\|[-:\s]+\|$/.test(rows[1]);
                    const ds = hasSep ? 2 : 1;
                    const hc = rows[0].split('|').slice(1, -1).map(c => c.trim());
                    const cc = hc.length;
                    const hr = new TableRow({ tableHeader: true, children: hc.map(c => new TableCell({ children: [new Paragraph({ text: c, bold: true, alignment: AlignmentType.CENTER })], width: { size: 100 / cc, type: WidthType.PERCENTAGE } })) });
                    const dr = [];
                    for (let r = ds; r < rows.length; r++) {
                        dr.push(new TableRow({ children: rows[r].split('|').slice(1, -1).map(c => c.trim()).map(c => new TableCell({ children: [new Paragraph({ text: c })] })) }));
                    }
                    children.push(new Table({ rows: [hr, ...dr], width: { size: 100, type: WidthType.PERCENTAGE } }));
                    children.push(new Paragraph({ spacing: { after: 200 } }));
                    continue;
                }
                // Bold
                const bp = t.split(/(\*\*[^*]+\*\*)/);
                if (bp.length > 1) {
                    children.push(new Paragraph({ children: bp.map(p => p.startsWith('**') && p.endsWith('**') ? new TextRun({ text: p.slice(2, -2), bold: true }) : new TextRun({ text: p })), spacing: { after: 100 } }));
                } else {
                    children.push(new Paragraph({ text: t, spacing: { after: 100 } }));
                }
            }
            const doc = new DocxDocument({ sections: [{ children }] });
            const buf = await Packer.toBuffer(doc);
            writeFileSync(filePath, buf);
            return { success: true, message: `Word 文档已生成: ${filePath} (${(buf.length/1024).toFixed(1)}KB)` };
        }
        if (ext === '.xlsx') {
            const ExcelJS = _require('exceljs');
            const wb = new ExcelJS.Workbook();
            const lines = content.split('\n');
            let si = 0;
            for (let i = 0; i < lines.length; i++) {
                const t = lines[i].trim();
                if (t.startsWith('|') && t.endsWith('|')) {
                    const tbl = [];
                    while (i < lines.length) { const l = lines[i].trim(); if (l.startsWith('|') && l.endsWith('|')) { tbl.push(l); i++; } else break; }
                    i--;
                    if (tbl.length < 2) continue;
                    si++;
                    const ws = wb.addWorksheet(si === 1 ? 'Sheet1' : `Sheet${si}`);
                    const hasSep = /^\|[-:\s]+\|$/.test(tbl[1]);
                    const ds = hasSep ? 2 : 1;
                    const hc = tbl[0].split('|').slice(1, -1).map(c => c.trim());
                    ws.addRow(hc).font = { bold: true };
                    for (let r = ds; r < tbl.length; r++) ws.addRow(tbl[r].split('|').slice(1, -1).map(c => c.trim()));
                    ws.columns.forEach(c => c.width = 20);
                }
            }
            if (si === 0) {
                const ws = wb.addWorksheet('Sheet1');
                lines.forEach(l => { const c = l.split('\t').map(x => x.trim()).filter(Boolean); if (c.length) ws.addRow(c); });
            }
            const buf = await wb.xlsx.writeBuffer();
            writeFileSync(filePath, buf);
            return { success: true, message: `Excel 文档已生成: ${filePath} (${(buf.length/1024).toFixed(1)}KB)` };
        }
        if (ext === '.pptx') {
            const pptxgen = _require('pptxgenjs');
            const pres = new pptxgen();
            const lines = content.split('\n');
            let slide = null, title = '', body = [];
            function flush() {
                if (!slide) return;
                if (title) slide.addText(title, { x: 0.5, y: 0.3, w: 9, h: 0.8, fontSize: 28, bold: true, color: '333333' });
                if (body.length) slide.addText(body.join('\n'), { x: 0.5, y: title ? 1.3 : 0.5, w: 9, h: 5.5, fontSize: 18, color: '555555', valign: 'top' });
            }
            for (const line of lines) {
                const t = line.trim();
                const hm = t.match(/^(#{1,4})\s+(.+)/);
                if (hm) { flush(); title = hm[2]; body = []; slide = pres.addSlide(); }
                else if (t) body.push(t.replace(/\*\*/g, ''));
            }
            flush();
            if (pres.slides.length === 0) {
                pres.addSlide().addText(content.slice(0, 500), { x: 0.5, y: 0.5, w: 9, h: 6, fontSize: 18, color: '555555' });
            }
            const buf = await pres.write({ outputType: 'nodebuffer' });
            writeFileSync(filePath, buf);
            return { success: true, message: `PPT 文档已生成: ${filePath} (${(buf.length/1024).toFixed(1)}KB)` };
        }
    } catch (e) {
        if (e.code === 'MODULE_NOT_FOUND') {
            return { success: false, error: `缺少依赖包，请运行: npm install docx exceljs pptxgenjs` };
        }
        return { success: false, error: `生成文档失败: ${e.message}` };
    }
}

async function executeTool(name, args, options = {}) {
    try {
        switch (name) {
            case 'write_file': {
                const fullPath = resolvePath(args.path, options);
                const dir = dirname(fullPath);
                if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
                writeFileSync(fullPath, args.content, 'utf-8');
                return { success: true, message: `File written: ${args.path} (${args.content.length} chars)` };
            }
            case 'read_file': {
                const fullPath = resolvePath(args.path, options);
                if (!existsSync(fullPath)) return { success: false, error: `文件不存在: ${args.path}。用 list_directory 查看目录下有哪些文件。` };
                const raw = readFileSync(fullPath, 'utf-8');
                const lines = raw.split('\n');
                const totalLines = lines.length;
                // 行级读取
                const start = (args.offset > 0) ? args.offset - 1 : 0;
                const end = (args.limit > 0) ? start + args.limit : totalLines;
                const sliced = lines.slice(start, end);
                const result = sliced.join('\n');
                const limit = 20000;
                const truncated = result.length > limit;
                const finalContent = truncated ? result.slice(0, limit) : result;
                return {
                    success: true, content: finalContent,
                    totalLines, startLine: start + 1, endLine: Math.min(end, totalLines),
                    size: raw.length, truncated,
                    hint: truncated ? `文件共 ${totalLines} 行，当前显示第 ${start+1}-${Math.min(end, totalLines)} 行（已截断）。用 offset=${start+1}&limit 续读后续内容。` : undefined
                };
            }
            case 'list_directory': {
                const fullPath = resolvePath(args.path || '.', options);
                if (!existsSync(fullPath)) return { success: false, error: `目录不存在: ${args.path}。用 "." 列出当前工作目录。` };
                const entries = readdirSync(fullPath).map(name => {
                    try {
                        const stat = statSync(join(fullPath, name));
                        return { name, type: stat.isDirectory() ? 'directory' : 'file', size: stat.isFile() ? stat.size : undefined };
                    } catch { return { name, type: 'unknown' }; }
                });
                return { success: true, path: args.path || '.', entries };
            }
            case 'execute_command': {
                try {
                    const output = execSync(args.command, {
                        cwd: WORK_DIR, encoding: 'utf-8', timeout: 30000,
                        stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: 1024 * 1024
                    });
                    return { success: true, output: output.slice(0, 2000), exitCode: 0, truncated: output.length > 2000 };
                } catch (e) {
                    return { success: false, output: (e.stdout || '').slice(0, 3000), error: (e.stderr || e.message || '').slice(0, 2000), exitCode: e.status || 1 };
                }
            }
            case 'search_files': {
                try {
                    const searchPath = resolvePath(args.path || '.', options);
                    const cmd = process.platform === 'win32'
                        ? `findstr /S /N /I /C:"${args.pattern}" "${searchPath}\\*"`
                        : `grep -rnI "${args.pattern}" "${searchPath}" --include="*" | head -30`;
                    const output = execSync(cmd, { encoding: 'utf-8', timeout: 15000, stdio: ['pipe', 'pipe', 'pipe'] });
                    return { success: true, matches: output.slice(0, 2000) };
                } catch (e) {
                    if (e.status === 1) return { success: true, matches: '', message: 'No matches found' };
                    return { success: false, error: e.message };
                }
            }
            case 'edit_file': {
                const fullPath = resolvePath(args.path, options);
                if (!existsSync(fullPath)) return { success: false, error: `File not found: ${args.path}` };
                const content = readFileSync(fullPath, 'utf-8');
                const idx = content.indexOf(args.old_text);
                if (idx === -1) return { success: false, error: '旧文本在文件中未找到。请确保 old_text 完全匹配文件中的内容（包括换行和缩进）。' };
                const newContent = content.slice(0, idx) + args.new_text + content.slice(idx + args.old_text.length);
                writeFileSync(fullPath, newContent, 'utf-8');
                return { success: true, message: `Edited: ${args.path} (replaced ${args.old_text.length} chars)` };
            }
            case 'glob': {
                const searchPath = resolvePath(args.path || '.', options);
                if (!existsSync(searchPath)) return { success: false, error: `Directory not found: ${args.path || '.'}` };
                // Simple recursive glob using findstr on Windows, find on Unix
                const pattern = args.pattern.replace(/\\/g, '/');
                const isWin = process.platform === 'win32';
                const cmd = isWin
                    ? `dir /S /B "${searchPath}" 2>nul | findstr /R /I "${pattern.replace(/\*/g, '.*').replace(/\?/g, '.')}" 2>nul`
                    : `find "${searchPath}" -type f -name 2>/dev/null | head -100`;
                try {
                    const output = execSync(cmd, { cwd: WORK_DIR, encoding: 'utf-8', timeout: 15000, stdio: ['pipe', 'pipe', 'pipe'] });
                    const files = output.trim().split('\n').filter(Boolean).slice(0, 50);
                    return { success: true, files };
                } catch {
                    return { success: true, files: [], message: 'No matches found' };
                }
            }
            case 'grep': {
                try {
                    const searchPath = resolvePath(args.path || '.', options);
                    const globFilter = args.glob ? `--include="${args.glob}"` : '';
                    const cmd = process.platform === 'win32'
                        ? `findstr /S /N /I /C:"${args.pattern}" "${searchPath}\\*" 2>nul`
                        : `grep -rnI "${args.pattern}" "${searchPath}" ${globFilter} | head -50`;
                    const output = execSync(cmd, { encoding: 'utf-8', timeout: 15000, stdio: ['pipe', 'pipe', 'pipe'] });
                    const lines = output.trim().split('\n').filter(Boolean).slice(0, 50);
                    return { success: true, matches: lines.join('\n'), count: lines.length };
                } catch (e) {
                    if (e.status === 1) return { success: true, matches: '', count: 0, message: 'No matches found' };
                    return { success: false, error: e.message };
                }
            }
            case 'git_status': {
                try {
                    const repoPath = resolvePath(args.path || '.', options);
                    const output = execSync('git status --short', { cwd: repoPath, encoding: 'utf-8', timeout: 10000, stdio: ['pipe', 'pipe', 'pipe'] });
                    const branch = execSync('git rev-parse --abbrev-ref HEAD', { cwd: repoPath, encoding: 'utf-8', timeout: 5000, stdio: ['pipe', 'pipe', 'pipe'] }).trim();
                    return { success: true, branch, status: output.trim() || '(clean)' };
                } catch (e) {
                    return { success: false, error: e.message || 'Not a git repository or git not available' };
                }
            }
            case 'git_diff': {
                try {
                    const repoPath = WORK_DIR;
                    const fileArg = args.path ? `-- "${args.path}"` : '';
                    const stagedArg = args.staged ? '--staged' : '';
                    const output = execSync(`git diff ${stagedArg} ${fileArg}`, { cwd: repoPath, encoding: 'utf-8', timeout: 10000, stdio: ['pipe', 'pipe', 'pipe'] });
                    return { success: true, diff: output || '(no changes)' };
                } catch (e) {
                    return { success: false, error: e.message };
                }
            }
            case 'git_commit': {
                try {
                    const repoPath = WORK_DIR;
                    execSync('git add -A', { cwd: repoPath, encoding: 'utf-8', timeout: 10000, stdio: ['pipe', 'pipe', 'pipe'] });
                    const output = execSync(`git commit -m "${args.message.replace(/"/g, '\\"')}"`, { cwd: repoPath, encoding: 'utf-8', timeout: 15000, stdio: ['pipe', 'pipe', 'pipe'] });
                    return { success: true, message: output.trim() };
                } catch (e) {
                    return { success: false, error: e.stdout || e.stderr || e.message };
                }
            }
            case 'move_file': {
                const srcPath = resolvePath(args.source, options);
                const dstPath = resolvePath(args.dest, options);
                if (!existsSync(srcPath)) return { success: false, error: `Source not found: ${args.source}` };
                const dstDir = dirname(dstPath);
                if (!existsSync(dstDir)) mkdirSync(dstDir, { recursive: true });
                renameSync(srcPath, dstPath);
                return { success: true, message: `Moved: ${args.source} → ${args.dest}` };
            }
            case 'delete_file': {
                const fullPath = resolvePath(args.path, options);
                if (!existsSync(fullPath)) return { success: false, error: `File not found: ${args.path}` };
                unlinkSync(fullPath);
                return { success: true, message: `Deleted: ${args.path}` };
            }
            case 'web_search': {
                // 框架拦截：搜索去重 + 硬上限
                if (!runAgent._searchCache) runAgent._searchCache = new Map();
                const searchCache = runAgent._searchCache;
                const normalizedQuery = args.query.trim().toLowerCase();
                // 去重检查：编辑距离 ≤2 视为重复
                for (const [cachedQuery, cachedResult] of searchCache) {
                    const dist = cachedQuery.length === normalizedQuery.length ?
                        [...cachedQuery].filter((c, i) => c !== normalizedQuery[i]).length : 999;
                    if (dist <= 2) {
                        return { success: true, ...cachedResult, _warning: '重复搜索已拦截。请用 web_fetch 打开链接或直接回答，不要再搜索。' };
                    }
                }
                // 硬上限：累计 2 次后拒绝
                if (searchCache.size >= 2) {
                    // 从可用工具中移除 web_search 和 web_fetch
                    runAgent._toolsExhausted = true;
                    return { success: false, error: '搜索次数已达上限(2次)。请立即用 web_fetch 打开已有链接获取全文，或用已有信息直接回答。不要再搜索。' };
                }
                try {
                    const q = encodeURIComponent(args.query);
                    let html = await fetchHTML(`https://www.bing.com/search?q=${q}&setlang=zh-cn`, { 'Accept-Language': 'zh-CN,zh;q=0.9' });
                    const results = [];

                    // Bing Pattern 1: b_algo results
                    const algoRegex = /<li class="b_algo"[^>]*?>[\s\S]*?<h2[^>]*?><a[^>]*?href="(https?:\/\/[^"]+)"[^>]*?>([\s\S]*?)<\/a><\/h2>[\s\S]*?(?:<p[^>]*?>([\s\S]*?)<\/p>)?/gi;
                    let m;
                    while ((m = algoRegex.exec(html)) !== null && results.length < 8) {
                        const title = m[2].replace(/<[^>]+>/g, '').trim();
                        const link = m[1];
                        const snippet = (m[3] || '').replace(/<[^>]+>/g, '').trim();
                        if (link && !link.includes('go.microsoft.com')) {
                            results.push({ title, url: link, snippet });
                        }
                    }

                    // Bing Pattern 2: generic h2 + link
                    if (results.length === 0) {
                        const h2Regex = /<h2[^>]*?><a[^>]*?href="(https?:\/\/[^"]+)"[^>]*?>([\s\S]*?)<\/a><\/h2>/gi;
                        while ((m = h2Regex.exec(html)) !== null && results.length < 8) {
                            const title = m[2].replace(/<[^>]+>/g, '').trim();
                            const link = m[1];
                            if (!results.find(r => r.url === link) && !link.includes('go.microsoft.com')) {
                                results.push({ title, url: link, snippet: '' });
                            }
                        }
                    }

                    // Bing Pattern 3: cite tags
                    if (results.length === 0) {
                        const citeRegex = /<cite[^>]*?>([\s\S]*?)<\/cite>/gi;
                        while ((m = citeRegex.exec(html)) !== null && results.length < 8) {
                            const cite = m[1].replace(/<[^>]+>/g, '').trim();
                            const urlStr = cite.startsWith('http') ? cite : 'https://' + cite;
                            if (cite) results.push({ title: cite, url: urlStr, snippet: '' });
                        }
                    }

                    // Fallback: DuckDuckGo HTML search (更稳定的备选)
                    if (results.length === 0) {
                        try {
                            const ddgHtml = await fetchHTML(`https://html.duckduckgo.com/html/?q=${q}`, { 'Accept-Language': 'zh-CN,zh;q=0.9' });
                            const ddgRegex = /<a[^>]*?class="result__a"[^>]*?href="(https?:\/\/[^"]+)"[^>]*?>([\s\S]*?)<\/a>[\s\S]*?<a[^>]*?class="result__snippet"[^>]*?>([\s\S]*?)<\/a>/gi;
                            while ((m = ddgRegex.exec(ddgHtml)) !== null && results.length < 8) {
                                const title = m[2].replace(/<[^>]+>/g, '').trim();
                                const link = m[1];
                                const snippet = m[3].replace(/<[^>]+>/g, '').trim();
                                if (link && title) results.push({ title, url: link, snippet });
                            }
                            // DDG 简单回退：只匹配链接
                            if (results.length === 0) {
                                const ddgSimple = /<a[^>]*?class="result__a"[^>]*?href="(https?:\/\/[^"]+)"[^>]*?>([\s\S]*?)<\/a>/gi;
                                while ((m = ddgSimple.exec(ddgHtml)) !== null && results.length < 8) {
                                    const title = m[2].replace(/<[^>]+>/g, '').trim();
                                    const link = m[1];
                                    if (link && title) results.push({ title, url: link, snippet: '' });
                                }
                            }
                        } catch {}
                    }

                    if (results.length === 0) {
                        const noResultMsg = '搜索无结果。请如实告诉用户"没搜到，建议换个关键词或手动搜索"。绝对禁止编造内容。';
                        searchCache.set(normalizedQuery, { query: args.query, results: [], formatted: noResultMsg });
                        return { success: false, query: args.query, results: [], formatted: noResultMsg, raw: html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').slice(0, 1000) };
                    }
                    const formatted = results.map((r, i) =>
                        `${i + 1}. ${r.title}\n   链接: ${r.url}\n   摘要: ${r.snippet || '(无)'}`
                    ).join('\n\n');
                    const guided = '以上是搜索摘要，不是全文。请立即用 web_fetch 打开第 1 条链接获取全文，然后基于全文回答。禁止编造。\n\n' + formatted + '\n\n立即调用 web_fetch 打开第 1 条链接。';
                    searchCache.set(normalizedQuery, { query: args.query, results, formatted: guided });
                    return { success: true, query: args.query, results, formatted: guided };
                } catch (e) {
                    return { success: false, error: `搜索失败: ${e.message}` };
                }
            }
            case 'web_fetch': {
                try {
                    const url = args.url;
                    if (!/^https?:\/\/.+/.test(url)) return { success: false, error: 'Invalid URL format' };
                    // UA 轮换列表：遇到 403 换一个身份重试
                    const UA_LIST = [
                        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
                        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
                        'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:133.0) Gecko/20100101 Firefox/133.0',
                    ];
                    let resp = null;
                    let lastErr = null;
                    for (let uaIdx = 0; uaIdx < UA_LIST.length; uaIdx++) {
                        try {
                            resp = await fetchExternal(url, { 'User-Agent': UA_LIST[uaIdx] }, null, 'GET');
                            if (resp.status < 400) break;
                            lastErr = resp.status;
                            // 403/406 换 UA 再试，其他错误直接放弃
                            if (resp.status !== 403 && resp.status !== 406) break;
                        } catch (e) {
                            lastErr = e.message;
                            break;
                        }
                    }
                    if (!resp || resp.status >= 400) {
                        return { success: false, error: `HTTP ${lastErr || 'error'}. 请试下一个链接，或如实告诉用户该页面无法访问。` };
                    }
                    const ct = (resp.headers || {})['content-type'] || '';
                    const data = resp.data || '';
                    if (ct.includes('application/json')) {
                        runAgent._hasFetchedRealContent = true;
                        return { success: true, url, content: data.slice(0, 4000), type: 'json', truncated: data.length > 4000 };
                    }
                    // Strip HTML to readable text: 先删非内容区域，再提取
                    let text = data
                        .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
                        .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
                        .replace(/<noscript[^>]*>[\s\S]*?<\/noscript>/gi, '')
                        .replace(/<head[^>]*>[\s\S]*?<\/head>/gi, '')
                        .replace(/<nav[^>]*>[\s\S]*?<\/nav>/gi, '')
                        .replace(/<footer[^>]*>[\s\S]*?<\/footer>/gi, '')
                        .replace(/<header[^>]*>[\s\S]*?<\/header>/gi, '')
                        .replace(/<aside[^>]*>[\s\S]*?<\/aside>/gi, '')
                        .replace(/<select[^>]*>[\s\S]*?<\/select>/gi, '')
                        .replace(/<br\s*\/?>/gi, '\n')
                        .replace(/<\/p>/gi, '\n')
                        .replace(/<\/div>/gi, '\n')
                        .replace(/<\/li>/gi, '\n')
                        .replace(/<\/h[1-6]>/gi, '\n')
                        .replace(/<[^>]+>/g, '')
                        .replace(/&nbsp;/g, ' ')
                        .replace(/&amp;/g, '&')
                        .replace(/&lt;/g, '<')
                        .replace(/&gt;/g, '>')
                        .replace(/&quot;/g, '"')
                        .replace(/&#39;/g, "'")
                        .replace(/&rsquo;/g, "'")
                        .replace(/&ldquo;/g, '"')
                        .replace(/&rdquo;/g, '"')
                        .replace(/&mdash;/g, '—')
                        .replace(/&ndash;/g, '–')
                        .replace(/\n{3,}/g, '\n\n')
                        .replace(/[ \t]{2,}/g, ' ')
                        .replace(/^\s*\n/gm, '')
                        .trim();
                    text = text.split('\n').filter(line => {
                        const t = line.trim();
                        if (t.length < 4) return false;
                        if (t.length < 20 && !/[，。！？、；：""''（）《》]/.test(t)) return false;
                        return true;
                    }).join('\n');
                    if (!text || text.length < 10) {
                        return { success: true, url, content: data.slice(0, 4000), type: 'raw', truncated: data.length > 4000 };
                    }
                    runAgent._hasFetchedRealContent = true;
                    return { success: true, url, content: text.slice(0, 4000), length: text.length, truncated: text.length > 4000 };
                } catch (e) {
                    return { success: false, error: `抓取失败: ${e.message}. 请试下一个链接。` };
                }
            }
            case 'generate_document': {
                // 防编造：AI 声明基于网页内容时才检查
                if (args.basedOnWebContent && !runAgent._hasFetchedRealContent) {
                    return { success: false, error: '未获取过真实网页内容，无法生成基于网络资料的文档。请先用 web_search 搜索，再用 web_fetch 打开链接获取全文。如果不是基于网络资料，请将 basedOnWebContent 设为 false。' };
                }
                const fullPath = resolvePath(args.path, options);
                const dir = dirname(fullPath);
                if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
                return await generateDocument(fullPath, args.content);
            }
            default:
                return { success: false, error: `Unknown tool: ${name}` };
        }
    } catch (e) {
        if (e.code === 'E_NEED_PATH_APPROVAL') {
            return {
                needsPathApproval: true,
                requestedPath: e.requestedPath,
                originalArg: e.originalArg,
                toolName: name,
                toolArgs: args
            };
        }
        return { success: false, error: e.message };
    }
}

// ─── Non-Streaming AI Calls (for tool loop) ──────────────────

async function callAI_OpenAI(messages, cfg, includeTools = true) {
    const model = cfg.OPENAI_MODEL || cfg.AI_DISPLAY_MODEL;
    const baseUrl = cfg.OPENAI_BASE_URL || 'https://api.openai.com/v1';
    const apiKey = cfg.OPENAI_API_KEY;
    // 清扫孤儿 tool 消息：删除没有前置 tool_calls 配对的 tool 角色消息
    const activeToolCallIds = new Set();
    const sanitized = [];
    for (const m of messages) {
        if (m.role === 'assistant' && m.tool_calls) {
            for (const tc of m.tool_calls) activeToolCallIds.add(tc.id);
        }
        if (m.role === 'tool' && !activeToolCallIds.has(m.tool_call_id)) continue; // 孤儿，跳过
        sanitized.push(m);
    }
    const payload = { model, messages: sanitized, stream: false, temperature: 0.6 };
    if (includeTools) payload.tools = toolsForOpenAI();
    const body = JSON.stringify(payload);
    const headers = {
        'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}`,
        'Content-Length': String(Buffer.byteLength(body))
    };
    if (cfg.OPENAI_BASE_URL?.includes('openrouter')) {
        headers['HTTP-Referer'] = 'http://localhost:3000';
        headers['X-Title'] = 'Portable AI Agent';
    }
    const resp = await fetchExternal(`${baseUrl}/chat/completions`, headers, body, 'POST');
    let data;
    try { data = JSON.parse(resp.data); } catch { throw new Error('Invalid response from AI API: ' + resp.data.slice(0, 300)); }
    // Check for API-level error
    if (data.error) {
        const errMsg = data.error.message || data.error.code || JSON.stringify(data.error);
        throw new Error(`API Error: ${errMsg}`);
    }
    const choice = data.choices?.[0]?.message;
    if (!choice) throw new Error('No response from AI: ' + resp.data.slice(0, 300));
    return {
        content: choice.content || '',
        toolCalls: (choice.tool_calls || []).map(tc => ({
            id: tc.id, name: tc.function.name,
            args: typeof tc.function.arguments === 'string' ? JSON.parse(tc.function.arguments) : tc.function.arguments
        })),
        rawMessage: choice
    };
}

async function callAI_Anthropic(messages, cfg, includeTools = true) {
    const model = cfg.AI_DISPLAY_MODEL || 'claude-3-5-sonnet-20241022';
    const apiKey = cfg.ANTHROPIC_API_KEY;
    let system = '';
    const activeToolIds = new Set();
    const filtered = [];
    for (const m of messages) {
        if (m.role === 'system') { system = m.content; continue; }
        // 追踪 tool_use ID
        if (m.role === 'assistant' && Array.isArray(m.content)) {
            for (const c of m.content) if (c.type === 'tool_use') activeToolIds.add(c.id);
        }
        // 清扫孤儿 tool_result
        if (m.role === 'user' && Array.isArray(m.content)) {
            const clean = m.content.filter(c => c.type !== 'tool_result' || activeToolIds.has(c.tool_use_id));
            if (clean.length === 0) continue; // 全孤儿，跳过整条消息
            filtered.push({ ...m, content: clean });
            continue;
        }
        filtered.push(m);
    }
    const payload = { model, messages: filtered, max_tokens: 4096, temperature: 0.5 };
    if (system) payload.system = system;
    if (includeTools) payload.tools = toolsForAnthropic();
    const body = JSON.stringify(payload);
    const headers = {
        'Content-Type': 'application/json', 'x-api-key': apiKey,
        'anthropic-version': '2023-06-01', 'Content-Length': String(Buffer.byteLength(body))
    };
    const resp = await fetchExternal('https://api.anthropic.com/v1/messages', headers, body, 'POST');
    const data = JSON.parse(resp.data);
    if (data.error) throw new Error(data.error.message || JSON.stringify(data.error));
    const textParts = (data.content || []).filter(c => c.type === 'text').map(c => c.text);
    const toolParts = (data.content || []).filter(c => c.type === 'tool_use');
    return {
        content: textParts.join('\n'),
        toolCalls: toolParts.map(tc => ({ id: tc.id, name: tc.name, args: tc.input })),
        stopReason: data.stop_reason
    };
}

async function callAI_Gemini(messages, cfg, includeTools = true) {
    const model = cfg.AI_DISPLAY_MODEL || 'gemini-2.0-pro-exp-02-05';
    const apiKey = cfg.GEMINI_API_KEY;
    // Convert messages to Gemini format
    const contents = [];
    for (const m of messages) {
        if (m.role === 'system') continue; // handled separately
        const role = m.role === 'assistant' ? 'model' : 'user';
        if (typeof m.content === 'string') {
            contents.push({ role, parts: [{ text: m.content }] });
        } else if (Array.isArray(m.parts)) {
            contents.push({ role, parts: m.parts });
        }
    }
    const payload = { contents, generationConfig: { temperature: 0.5 } };
    if (includeTools) payload.tools = toolsForGemini();
    // Add system instruction
    const sysMsg = messages.find(m => m.role === 'system');
    if (sysMsg) payload.system_instruction = { parts: [{ text: sysMsg.content }] };
    const body = JSON.stringify(payload);
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
    const headers = { 'Content-Type': 'application/json', 'Content-Length': String(Buffer.byteLength(body)) };
    const resp = await fetchExternal(url, headers, body, 'POST');
    const data = JSON.parse(resp.data);
    if (data.error) throw new Error(data.error.message || JSON.stringify(data.error));
    const parts = data.candidates?.[0]?.content?.parts || [];
    const textParts = parts.filter(p => p.text).map(p => p.text);
    const funcParts = parts.filter(p => p.functionCall);
    return {
        content: textParts.join('\n'),
        toolCalls: funcParts.map((p, i) => ({
            id: `gemini_call_${Date.now()}_${i}`, name: p.functionCall.name, args: p.functionCall.args || {}
        }))
    };
}

// Unified caller
async function callAI(messages, cfg, includeTools = true) {
    const provider = cfg.AI_PROVIDER;
    if (provider === 'openai' || provider === 'ollama') return callAI_OpenAI(messages, cfg, includeTools);
    if (provider === 'anthropic') return callAI_Anthropic(messages, cfg, includeTools);
    if (provider === 'gemini') return callAI_Gemini(messages, cfg, includeTools);
    throw new Error(`Unsupported provider for agent mode: ${provider}`);
}

// ─── Append tool results for each provider ───────────────────

function appendAssistantMessage(messages, aiResponse, provider) {
    if (provider === 'openai' || provider === 'ollama') {
        messages.push(aiResponse.rawMessage || {
            role: 'assistant', content: aiResponse.content || null,
            tool_calls: aiResponse.toolCalls.map(tc => ({
                id: tc.id, type: 'function',
                function: { name: tc.name, arguments: JSON.stringify(tc.args) }
            }))
        });
    } else if (provider === 'anthropic') {
        const content = [];
        if (aiResponse.content) content.push({ type: 'text', text: aiResponse.content });
        for (const tc of aiResponse.toolCalls) {
            content.push({ type: 'tool_use', id: tc.id, name: tc.name, input: tc.args });
        }
        messages.push({ role: 'assistant', content });
    } else if (provider === 'gemini') {
        const parts = [];
        if (aiResponse.content) parts.push({ text: aiResponse.content });
        for (const tc of aiResponse.toolCalls) {
            parts.push({ functionCall: { name: tc.name, args: tc.args } });
        }
        messages.push({ role: 'model', parts });
    }
}

function appendToolResult(messages, toolCall, result, provider) {
    const resultStr = typeof result === 'string' ? result : JSON.stringify(result);
    if (provider === 'openai' || provider === 'ollama') {
        messages.push({ role: 'tool', tool_call_id: toolCall.id, content: resultStr });
    } else if (provider === 'anthropic') {
        messages.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: toolCall.id, content: resultStr }] });
    } else if (provider === 'gemini') {
        messages.push({ role: 'user', parts: [{ functionResponse: { name: toolCall.name, response: { result } } }] });
    }
}

// ─── Approval System ─────────────────────────────────────────

const pendingApprovals = new Map();

function waitForApproval(callId, timeoutMs = 120000) {
    return new Promise((resolve) => {
        const timer = setTimeout(() => {
            pendingApprovals.delete(callId);
            resolve(false);
        }, timeoutMs);
        pendingApprovals.set(callId, { resolve, timer });
    });
}

function resolveApproval(callId, approved) {
    const pending = pendingApprovals.get(callId);
    if (pending) {
        clearTimeout(pending.timer);
        pending.resolve(approved);
        pendingApprovals.delete(callId);
        return true;
    }
    return false;
}

// ─── Agentic Loop ────────────────────────────────────────────

async function runAgent(allMessages, cfg, mode, sendSSE) {
    const provider = cfg.AI_PROVIDER;
    const MAX_ITERATIONS = 15;
    let finalText = '';

    const today = new Date().toISOString().slice(0, 10);
    function getAiDisplayName(cfg) {
        const baseUrl = (cfg.OPENAI_BASE_URL || '').toLowerCase();
        if (cfg.AI_PROVIDER === 'openai') {
            if (baseUrl.includes('deepseek')) return 'DeepSeek';
            if (baseUrl.includes('openrouter')) return 'OpenRouter';
            if (baseUrl.includes('nvidia')) return 'NVIDIA';
            if (baseUrl.includes('groq')) return 'Groq';
            if (cfg.OPENAI_BASE_URL) return '自定义 (OpenAI 兼容)';
            return 'OpenAI';
        }
        const map = { deepseek:'DeepSeek', openai:'OpenAI', anthropic:'Claude', gemini:'Gemini', openrouter:'OpenRouter', nvidia:'NVIDIA', ollama:'Ollama', lmstudio:'LM Studio', 'custom-openai':'自定义' };
        return map[cfg.AI_PROVIDER] || cfg.AI_PROVIDER || 'AI';
    }
    const aiName = getAiDisplayName(cfg);
    const systemPrompts = {
        normal: `【你是谁】
CCV v4.2（${aiName} 驱动），用中文沟通。
工作目录: ${WORK_DIR}
桌面: ${process.env.USERPROFILE ? process.env.USERPROFILE + '\\Desktop' : '无'}
今天: ${today}

【思维方式】
1. 需求模糊先问清：用户说"优化一下""改改这个"，先追问具体哪里、怎么改，不要猜。
2. 多步任务先列计划：涉及3步以上的操作，先用一句话列出步骤让用户确认，再动手。
3. 做完自检：操作完成后重新读关键文件确认修改正确，发现问题自己修。
4. 出错换方案：工具返回错误时分析原因，换一种方式重试，不要直接放弃。

【铁律】
1. 能编辑就不新建，只改用户让改的，别顺手修别的东西。
2. 读文件用 read_file，大文件用 offset/limit 分段读。搜文件用 glob/grep。
3. 生成文档必须用 generate_document，禁止 execute_command 装包跑脚本。
4. 搜不到就说搜不到，抓取失败就说失败。绝对禁止编造内容。
5. 用中文回复，说人话。有结果说结果，没结果说没找到。
6. 写代码遵循已有风格，处理边界情况和错误。

【搜索规则】
web_search 返回的只是标题+链接+摘要，不是全文！
正确: 搜索 → 挑第1条链接 → web_fetch 打开 → 整理全文回答
错误: 搜索 → 不满意 → 再搜索 → 死循环；或只看摘要就回答
同一话题最多搜索 2 次。搜完必须 web_fetch 打开链接。
如果 fetch 失败，试下一个链接。全失败就如实说。

【停止条件】
以下情况直接回答，不要再调工具：
- 已 web_fetch 获取全文并整理好
- 已搜索 2 次
- 已完成用户请求的文件操作
- 问题不需要工具`,

        limitless: `【你是谁】
CCV v4.2-自主模式（${aiName} 驱动）。无需确认，直接执行。
工作目录: ${WORK_DIR}
桌面: ${process.env.USERPROFILE ? process.env.USERPROFILE + '\\Desktop' : '无'}
今天: ${today}

【思维方式】
1. 需求模糊先问清，不要猜。
2. 多步任务先列计划。
3. 做完自检确认正确。
4. 出错换方案重试。

【铁律】
1. 能编辑就不新建，只改用户让改的。
2. 读文件用 read_file，搜文件用 glob/grep。
3. 生成文档用 generate_document，禁止装包跑脚本。
4. 搜不到就说搜不到，禁止编造。
5. 写代码遵循已有风格，处理边界情况。

【搜索】
web_search 返回摘要不是全文。正确: 搜索 → web_fetch 打开 → 回答。
同一话题最多 2 次搜索。完成请求后直接给最终回答。`,

        plan: `【你是谁】
CCV v4.2-计划模式（${aiName} 驱动）。只读，不能写/删/执行。
工作目录: ${WORK_DIR}
桌面: ${process.env.USERPROFILE ? process.env.USERPROFILE + '\\Desktop' : '无'}
今天: ${today}

【思维方式】
分析用户需求，需求模糊先问清。列出清晰的执行计划，让用户确认后再切到普通模式执行。

【规则】
只能搜索和读文件。输出文字计划，不要动手执行。
搜不到就说搜不到，禁止编造。同一话题最多搜索 2 次。`
    };

    // Build system message: base prompt + optional CLAUDE.md
    let sysContent = systemPrompts[mode] || systemPrompts.normal;
    const claudeMdPaths = [join(WORK_DIR, 'CLAUDE.md'), join(WORK_DIR, '.claude', 'CLAUDE.md')];
    for (const mdPath of claudeMdPaths) {
        if (existsSync(mdPath)) {
            try {
                const mdContent = readFileSync(mdPath, 'utf-8').trim();
                if (mdContent) {
                    sysContent += `\n\n--- Project Rules (from ${mdPath}) ---\n${mdContent}`;
                }
            } catch {}
        }
    }
    if (allMessages.length === 0 || allMessages[0].role !== 'system') {
        allMessages.unshift({ role: 'system', content: sysContent });
    }

    // 增强最后一条用户消息：末尾追加搜索铁律（利用小模型近因效应）
    for (let i = allMessages.length - 1; i >= 0; i--) {
        if (allMessages[i].role === 'user') {
            const orig = typeof allMessages[i].content === 'string' ? allMessages[i].content : '';
            if (orig && !orig.includes('【铁律】')) {
                allMessages[i] = { ...allMessages[i], content: orig + '\n\n【铁律】搜索后用 web_fetch 打开链接。禁止只看摘要就回答。禁止编造。' };
            }
            break;
        }
    }

    function translateError(msg) {
        if (/service.*busy|too busy|overload/i.test(msg)) return '服务繁忙，请稍后重试或切换供应商';
        if (/rate.?limit/i.test(msg)) return '请求频率过高，请稍后重试';
        if (/timeout/i.test(msg)) return '请求超时，服务响应太慢';
        if (/unauthorized|invalid.*key/i.test(msg)) return 'API 密钥无效，请检查配置';
        if (/insufficient.*quota|billing/i.test(msg)) return 'API 额度不足，请充值或换 Key';
        if (/model.*not.*found/i.test(msg)) return '模型不存在，请检查模型名称';
        return msg;
    }

    let webToolStreak = 0;
    let silentCount = 0;
    let interrupted = false;
    // 防编造：跟踪是否成功获取过真实网页内容
    runAgent._hasFetchedRealContent = false;
    runAgent._searchCount = 0;
    runAgent._fetchCount = 0;
    runAgent._approvedPaths = new Set();

    // 跨目录审批包装
    async function execWithPathApproval(tc, sendSSE) {
        let result = await executeTool(tc.name, tc.args);
        if (result.needsPathApproval) {
            const pathId = `path_${Date.now()}`;
            sendSSE({ type: 'path_approval_needed', id: pathId,
                toolCallId: tc.id,
                requestedPath: result.requestedPath,
                toolName: result.toolName,
                message: `AI 需要访问工作目录外的路径: ${result.requestedPath}`
            });
            const approved = await waitForApproval(pathId, 60000);
            if (approved) {
                runAgent._approvedPaths.add(dirname(result.requestedPath));
                sendSSE({ type: 'tool_call_status', id: tc.id, status: 'executing' });
                result = await executeTool(tc.name, tc.args, { skipPathCheck: true });
            } else {
                result = { success: false, error: '用户拒绝了跨目录访问请求' };
            }
        }
        return result;
    }

    // 注入用户消息（处理 provider 差异）
    function injectUserMsg(content) {
        if (provider === 'anthropic') {
            allMessages.push({ role: 'user', content: [{ type: 'text', text: content }] });
        } else if (provider === 'gemini') {
            allMessages.push({ role: 'user', parts: [{ text: content }] });
        } else {
            allMessages.push({ role: 'user', content });
        }
    }

    // Token 估算：中文≈1.5字符/token，英文≈4字符/token，取平均≈3
    function estimateTokens(msgs) {
        let chars = 0;
        for (const m of msgs) {
            if (typeof m.content === 'string') chars += m.content.length;
            else if (Array.isArray(m.content)) chars += JSON.stringify(m.content).length;
            if (m.tool_calls) chars += JSON.stringify(m.tool_calls).length;
            if (m.tool_call_id) chars += m.tool_call_id.length;
        }
        // 工具定义的固定开销（15个工具×约60字符描述）
        const toolOverhead = 900;
        return Math.round((chars + toolOverhead) / 3);
    }

    function maybeNudge(iteration) {
        if (webToolStreak >= 3) {
            injectUserMsg('已连续搜索多次。请停止搜索，用已有信息直接给出最终回答。');
            webToolStreak = 0;
        }
        if (iteration >= 12) {
            injectUserMsg('对话轮次已达上限。请立即基于已有信息给出最终答案，不要再调工具。');
        }
    }

    function compressHistory(msgs) {
        const totalChars = msgs.reduce((s, m) => s + (typeof m.content === 'string' ? m.content.length : JSON.stringify(m.content||'').length), 0);
        if (totalChars < 50000) return msgs;
        // 保留首条（系统）+ 最近消息，中间压缩为摘要
        // 关键：切分点必须在"安全"位置，不能切断 tool_calls/tool_result 配对
        const first = msgs[0];
        let splitIdx = msgs.length - 4;
        if (splitIdx < 1) splitIdx = 1;
        // 向后扩展：如果 splitIdx 处是 tool 结果，往前找到它的 tool_calls
        while (splitIdx > 1) {
            const m = msgs[splitIdx];
            const isToolResult = m.role === 'tool' ||
                (m.role === 'user' && Array.isArray(m.content) && m.content.some(c => c.type === 'tool_result'));
            if (isToolResult) { splitIdx--; continue; }
            break;
        }
        // 再向前：如果前一个是带 tool_calls 的 assistant，也包含进来
        while (splitIdx > 1) {
            const prev = msgs[splitIdx - 1];
            const hasToolCalls = prev.role === 'assistant' && (
                (prev.tool_calls && prev.tool_calls.length > 0) ||
                (Array.isArray(prev.content) && prev.content.some(c => c.type === 'tool_use'))
            );
            if (hasToolCalls) { splitIdx--; continue; }
            break;
        }
        const last = msgs.slice(splitIdx);
        const mid = msgs.slice(1, splitIdx);
        const compacted = [first];
        let summary = '';
        for (const m of mid) {
            if (m.role === 'user' && typeof m.content === 'string') {
                summary += '用户: ' + m.content.slice(0, 80) + '\n';
            } else if (m.role === 'assistant' && !m.tool_calls && !(Array.isArray(m.content) && m.content.some(c => c.type === 'tool_use'))) {
                summary += 'AI: ' + (typeof m.content === 'string' ? m.content.slice(0, 80) : '') + '\n';
            }
        }
        if (summary) {
            compacted.push({ role: 'user', content: '[对话历史摘要]\n' + summary + '\n--- 以下为最近消息 ---' });
        }
        compacted.push(...last);
        return compacted;
    }

    for (let iter = 0; iter < MAX_ITERATIONS; iter++) {
        // 保留系统提示，小模型需要反复看到规则
        sendSSE({ type: 'agent_thinking', iteration: iter + 1, estTokens: estimateTokens(allMessages) });

        // 自动压缩历史
        allMessages = compressHistory(allMessages);

        let aiResponse;
        let lastErr = null;
        for (let attempt = 0; attempt < 2; attempt++) {
            try {
                // 计划模式：不给工具，强制纯文本出计划
                // 工具耗尽时：不给工具
                const activeTools = (mode === 'plan' || runAgent._toolsExhausted) ? false : true;
                aiResponse = await callAI(allMessages, cfg, activeTools);
                lastErr = null;
                break;
            } catch (e) {
                lastErr = e;
                const msg = e.message || '';
                const retryable = /busy|timeout|rate.?limit|overload|too many|503|502|429/i.test(msg);
                if (retryable && attempt === 0) {
                    sendSSE({ type: 'agent_reasoning', content: '服务繁忙，等待重试...', iteration: iter + 1 });
                    await new Promise(r => setTimeout(r, 2500));
                    continue;
                }
                break;
            }
        }
        if (lastErr) {
            const e = lastErr;
            if (iter === 0) {
                try {
                    sendSSE({ type: 'agent_reasoning', content: '此模型不支持工具调用，切换到纯聊天模式...', iteration: 1 });
                    aiResponse = await callAI(allMessages, cfg, false);
                } catch (e2) {
                    const errText = `⚠️ ${translateError(e2.message)}`;
                    sendSSE({ type: 'agent_error', error: e2.message });
                    return errText;
                }
            } else {
                const errText = `⚠️ ${translateError(e.message)}`;
                sendSSE({ type: 'agent_error', error: e.message });
                return errText;
            }
        }

        // 如果 AI 只调工具没说明，自动生成状态文字
        if (!aiResponse.content && aiResponse.toolCalls.length > 0) {
            const toolNames = aiResponse.toolCalls.map(tc => {
                const shortArg = tc.name === 'web_search' ? (tc.args?.query||'').slice(0,30)
                    : tc.name === 'execute_command' ? (tc.args?.command||'').slice(0,30)
                    : tc.name === 'write_file' ? (tc.args?.path||'') : '';
                return `${tc.name}${shortArg?'('+shortArg+')':''}`;
            }).join('、');
            sendSSE({ type: 'agent_reasoning', content: `正在: ${toolNames}`, iteration: iter + 1 });
        }

        // Show AI's plan text alongside tool calls
        if (aiResponse.content && aiResponse.toolCalls.length > 0) {
            sendSSE({ type: 'agent_reasoning', content: aiResponse.content, iteration: iter + 1 });
        }

        // 统计网页工具连续使用次数
        const hasWebTools = aiResponse.toolCalls.some(tc => tc.name === 'web_search' || tc.name === 'web_fetch');
        webToolStreak = hasWebTools ? webToolStreak + 1 : 0;
        // 追踪搜索/抓取次数
        runAgent._searchCount += (aiResponse.toolCalls.some(tc => tc.name === 'web_search') ? 1 : 0);
        runAgent._fetchCount += (aiResponse.toolCalls.some(tc => tc.name === 'web_fetch') ? 1 : 0);

        // 搜索了但从不打开链接的检测
        if ((runAgent._searchCount || 0) >= 2 && (runAgent._fetchCount || 0) === 0) {
            injectUserMsg('你已经搜索了 ' + runAgent._searchCount + ' 次，但从未用 web_fetch 打开任何链接。请立即用 web_fetch 打开第 1 条搜索结果。');
            runAgent._fetchCount = -1;
        }
        // 所有链接都打不开的检测
        if ((runAgent._fetchCount || 0) > 0 && !runAgent._hasFetchedRealContent && runAgent._searchCount >= 1) {
            injectUserMsg('所有链接都无法访问。请如实告诉用户"这些链接都打不开"，建议换关键词或手动搜索。绝对禁止编造。');
            runAgent._hasFetchedRealContent = true; // 防止重复提醒
        }

        // Process tool calls
        if (aiResponse.toolCalls.length > 0) {
            appendAssistantMessage(allMessages, aiResponse, provider);

            // Plan mode: 计划模式不给工具，但万一 AI 还是调了工具，全部拒绝
            if (mode === 'plan') {
                for (const tc of aiResponse.toolCalls) {
                    sendSSE({ type: 'tool_call', id: tc.id, name: tc.name, label: TOOL_LABELS[tc.name] || tc.name, args: tc.args, needsApproval: false });
                    const rejectResult = { success: false, error: '计划模式不允许执行工具。请只输出文字计划，切换到普通模式后再执行。' };
                    appendToolResult(allMessages, tc, rejectResult, provider);
                    sendSSE({ type: 'tool_result', id: tc.id, name: tc.name, result: rejectResult });
                }
                // 注入提醒，让 AI 切换到文字回复
                injectUserMsg('计划模式不允许调用工具。请直接用文字说明你的分析和计划。');
                continue;
            }

            // Normal mode: batch approval — all tool calls shown at once, one approve/reject
            const isWrite = aiResponse.toolCalls.some(tc => WRITE_TOOLS.has(tc.name));
            if (isWrite && mode === 'normal') {
                // Send all tool calls to frontend
                for (const tc of aiResponse.toolCalls) {
                    sendSSE({ type: 'tool_call', id: tc.id, name: tc.name, label: TOOL_LABELS[tc.name] || tc.name, args: tc.args, needsApproval: true });
                }
                // Single batch approval
                const batchId = `batch_${Date.now()}`;
                sendSSE({ type: 'batch_approval_needed', id: batchId, count: aiResponse.toolCalls.length });
                const approved = await waitForApproval(batchId);
                if (!approved) {
                    // User rejected → stop the entire agent, don't let AI retry
                    for (const tc of aiResponse.toolCalls) {
                        const rejectResult = { success: false, error: 'Task cancelled by user' };
                        appendToolResult(allMessages, tc, rejectResult, provider);
                        sendSSE({ type: 'tool_rejected', id: tc.id });
                    }
                    finalText = '已取消操作。用户拒绝了该任务。';
                    interrupted = true;
                    sendSSE({ type: 'agent_text', content: finalText });
                    break;
                }
                // Execute all approved tool calls (读类并行，写类串行)
                const execOne = async (tc) => {
                    sendSSE({ type: 'tool_call_status', id: tc.id, status: 'executing' });
                    const r = await execWithPathApproval(tc, sendSSE);
                    appendToolResult(allMessages, tc, r, provider);
                    sendSSE({ type: 'tool_result', id: tc.id, name: tc.name, result: r });
                };
                const reads = aiResponse.toolCalls.filter(tc => READ_TOOLS.has(tc.name));
                const writes = aiResponse.toolCalls.filter(tc => !READ_TOOLS.has(tc.name));
                if (reads.length) await Promise.all(reads.map(execOne));
                for (const tc of writes) await execOne(tc);
                maybeNudge(iter);
                continue; // Let AI process results
            }

            // Limitless mode or read-only tools: execute directly (读类并行)
            for (const tc of aiResponse.toolCalls) {
                sendSSE({ type: 'tool_call', id: tc.id, name: tc.name, label: TOOL_LABELS[tc.name] || tc.name, args: tc.args, needsApproval: false });
            }
            { const execOne = async (tc) => {
                const r = await execWithPathApproval(tc, sendSSE);
                appendToolResult(allMessages, tc, r, provider);
                sendSSE({ type: 'tool_result', id: tc.id, name: tc.name, result: r });
            };
            const reads = aiResponse.toolCalls.filter(tc => READ_TOOLS.has(tc.name));
            const writes = aiResponse.toolCalls.filter(tc => !READ_TOOLS.has(tc.name));
            if (reads.length) await Promise.all(reads.map(execOne));
            for (const tc of writes) await execOne(tc); }

            maybeNudge(iter);
            continue;
        }

        // No tool calls — final text response
        finalText = aiResponse.content || '';
        // 空返回？追问一次，不要直接放弃
        if ((!finalText || finalText.trim().length === 0) && silentCount < 1 && iter < MAX_ITERATIONS - 1) {
            silentCount++;
            injectUserMsg('请用中文总结你目前的操作结果。');
            sendSSE({ type: 'agent_reasoning', content: '等待 AI 回应...', iteration: iter + 1 });
            continue;
        }
        if (!finalText || finalText.trim().length === 0) {
            finalText = '任务执行完毕。上方工具卡片显示了详细结果。';
        }
        sendSSE({ type: 'agent_text', content: finalText });
        break;
    }

    // 循环耗尽也没产出文本？兜底
    if (!finalText || finalText.trim().length === 0) {
        finalText = '执行完毕。上方的工具卡片显示了详细结果。';
    }
    sendSSE({ type: 'done', fullText: finalText, interrupted });
    return finalText;
}

// ─── AI Chat Proxy (existing simple chat — unchanged) ────────

async function streamChatResponse(messages, cfg, res) {
    const provider = cfg.AI_PROVIDER;
    const model = cfg.OPENAI_MODEL || cfg.AI_DISPLAY_MODEL;
    const baseUrl = cfg.OPENAI_BASE_URL || 'https://api.openai.com/v1';
    const apiKey = cfg.OPENAI_API_KEY || cfg.GEMINI_API_KEY || cfg.ANTHROPIC_API_KEY;

    res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'Access-Control-Allow-Origin': '*',
    });

    const sendSSE = (data) => res.write(`data: ${JSON.stringify(data)}\n\n`);

    // ── OpenAI-compatible (OpenRouter, Ollama, OpenAI) ────────
    if (provider === 'openai' || provider === 'ollama') {
        const body = JSON.stringify({ model, messages, stream: true });
        const headers = { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}`, 'Content-Length': Buffer.byteLength(body) };
        if (cfg.OPENAI_BASE_URL?.includes('openrouter')) {
            headers['HTTP-Referer'] = 'http://localhost:3000';
            headers['X-Title'] = 'Portable AI Dashboard';
        }
        let fullText = '';
        await streamExternal(`${baseUrl}/chat/completions`, headers, body,
            (chunk) => {
                chunk.split('\n').forEach(line => {
                    if (!line.startsWith('data: ')) return;
                    const raw = line.slice(6).trim();
                    if (raw === '[DONE]') return;
                    try {
                        const parsed = JSON.parse(raw);
                        const delta = parsed.choices?.[0]?.delta?.content || '';
                        if (delta) { fullText += delta; sendSSE({ type: 'delta', content: delta }); }
                    } catch {}
                });
            },
            () => { sendSSE({ type: 'done', fullText }); res.end(); }
        );
        return fullText;
    }

    // ── Anthropic ─────────────────────────────────────────────
    if (provider === 'anthropic') {
        const body = JSON.stringify({ model: model || 'claude-3-5-sonnet-20241022', messages, max_tokens: 4096, stream: true });
        const headers = { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'Content-Length': Buffer.byteLength(body) };
        let fullText = '';
        await streamExternal('https://api.anthropic.com/v1/messages', headers, body,
            (chunk) => {
                chunk.split('\n').forEach(line => {
                    if (!line.startsWith('data: ')) return;
                    try {
                        const parsed = JSON.parse(line.slice(6));
                        const delta = parsed.delta?.text || '';
                        if (delta) { fullText += delta; sendSSE({ type: 'delta', content: delta }); }
                    } catch {}
                });
            },
            () => { sendSSE({ type: 'done', fullText }); res.end(); }
        );
        return fullText;
    }

    // ── Gemini ────────────────────────────────────────────────
    if (provider === 'gemini') {
        const gemModel = model || 'gemini-2.0-pro-exp-02-05';
        const gemMessages = messages.map(m => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] }));
        const body = JSON.stringify({ contents: gemMessages });
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${gemModel}:streamGenerateContent?key=${apiKey}`;
        const headers = { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) };
        let fullText = '';
        await streamExternal(url, headers, body,
            (chunk) => {
                try {
                    const matches = chunk.match(/"text":\s*"((?:[^"\\]|\\.)*)"/g) || [];
                    matches.forEach(m => {
                        const text = JSON.parse('{' + m + '}').text || '';
                        if (text) { fullText += text; sendSSE({ type: 'delta', content: text }); }
                    });
                } catch {}
            },
            () => { sendSSE({ type: 'done', fullText }); res.end(); }
        );
        return fullText;
    }

    sendSSE({ type: 'error', content: 'Provider not configured or unsupported.' });
    res.end();
    return '';
}

// ─── Server ──────────────────────────────────────────────────

const server = createServer(async (req, res) => {
    const url = new URL(req.url, `http://localhost:${PORT}`);

    if (req.method === 'OPTIONS') {
        res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET,POST,DELETE,OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' });
        return res.end();
    }

    try {
        if (url.pathname === '/' && req.method === 'GET') {
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache, no-store, must-revalidate' });
            return res.end(readFileSync(HTML_FILE, 'utf-8'));
        }

        // Config
        if (url.pathname === '/api/config' && req.method === 'GET') return sendJSON(res, 200, readConfig());
        if (url.pathname === '/api/config' && req.method === 'POST') { const b = await readBody(req); writeConfig(b); return sendJSON(res, 200, { success: true }); }
        if (url.pathname === '/api/config/export' && req.method === 'GET') {
            if (!existsSync(ENV_FILE)) return sendJSON(res, 404, { error: 'No config' });
            res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Disposition': 'attachment; filename="ai_settings.env"' });
            return res.end(readFileSync(ENV_FILE, 'utf-8'));
        }
        if (url.pathname === '/api/config/import' && req.method === 'POST') { writeFileSync(ENV_FILE, await readBodyRaw(req), 'utf-8'); return sendJSON(res, 200, { success: true }); }

        // Models
        if (url.pathname === '/api/models' && req.method === 'GET') {
            const type = url.searchParams.get('type') || 'free';
            const result = await fetchExternal('https://openrouter.ai/api/v1/models');
            const parsed = JSON.parse(result.data);
            const models = (parsed.data || []).map(m => m.id).filter(id => type === 'free' ? id.endsWith(':free') : !id.endsWith(':free')).slice(0, 30);
            return sendJSON(res, 200, { models });
        }

        // NVIDIA NIM Models
        if (url.pathname === '/api/nvidia/models' && req.method === 'GET') {
            // NVIDIA NIM provides many models. We list the popular free/developer tier models here.
            const models = [
                'meta/llama-3.1-70b-instruct',
                'meta/llama-3.1-8b-instruct',
                'mistralai/mixtral-8x22b-instruct-v0.1',
                'mistralai/mixtral-8x7b-instruct-v0.1',
                'google/gemma-2-27b-it',
                'google/gemma-2-9b-it',
                'nvidia/nemotron-4-340b-instruct',
                'microsoft/phi-3-mini-128k-instruct'
            ];
            return sendJSON(res, 200, { models });
        }

        // DeepSeek Models
        if (url.pathname === '/api/deepseek/models' && req.method === 'POST') {
            const { key } = await readBody(req);
            const fallback = ['deepseek-v4-flash', 'deepseek-v4-pro'];
            try {
                const result = await fetchExternal('https://api.deepseek.com/models', { 'Authorization': `Bearer ${key}` });
                const parsed = JSON.parse(result.data);
                const models = (parsed.data || []).map(m => m.id).filter(Boolean);
                return sendJSON(res, 200, { models: models.length ? models : fallback });
            } catch {
                return sendJSON(res, 200, { models: fallback });
            }
        }

        // OpenAI-compatible Models
        if (url.pathname === '/api/openai-compatible/models' && req.method === 'POST') {
            const { baseUrl, key } = await readBody(req);
            if (!baseUrl) return sendJSON(res, 400, { models: [], error: 'Missing baseUrl' });
            const cleanBaseUrl = String(baseUrl).replace(/\/+$/, '');
            const apiKey = key || 'not-needed';
            try {
                const result = await fetchExternal(`${cleanBaseUrl}/models`, { 'Authorization': `Bearer ${apiKey}` });
                const parsed = JSON.parse(result.data);
                const models = (parsed.data || []).map(m => m.id).filter(Boolean);
                return sendJSON(res, 200, { models });
            } catch (e) {
                return sendJSON(res, 200, { models: [], error: e.message });
            }
        }

        // Verify Key
        if (url.pathname === '/api/verify-key' && req.method === 'POST') {
            const { provider, key, baseUrl } = await readBody(req);
            let valid = false;
            if (provider === 'openrouter') { const r = await fetchExternal('https://openrouter.ai/api/v1/auth/key', { 'Authorization': `Bearer ${key}` }); valid = r.status === 200; }
            else if (provider === 'nvidia') { const r = await fetchExternal('https://integrate.api.nvidia.com/v1/models', { 'Authorization': `Bearer ${key}` }); valid = r.status === 200; }
            else if (provider === 'deepseek') { const r = await fetchExternal('https://api.deepseek.com/models', { 'Authorization': `Bearer ${key}` }); valid = r.status === 200; }
            else if (provider === 'gemini') { const r = await fetchExternal(`https://generativelanguage.googleapis.com/v1beta/models?key=${key}`); valid = r.status === 200; }
            else if (provider === 'anthropic') { const r = await fetchExternal('https://api.anthropic.com/v1/models', { 'x-api-key': key, 'anthropic-version': '2023-06-01' }); valid = r.status === 200; }
            else if (provider === 'openai') { const r = await fetchExternal('https://api.openai.com/v1/models', { 'Authorization': `Bearer ${key}` }); valid = r.status === 200; }
            else if (provider === 'lmstudio') {
                try {
                    const cleanBaseUrl = String(baseUrl || 'http://localhost:1234/v1').replace(/\/+$/, '');
                    const r = await fetchExternal(`${cleanBaseUrl}/models`, { 'Authorization': 'Bearer lm-studio' });
                    valid = r.status === 200;
                } catch {
                    valid = false;
                }
            }
            else if (provider === 'custom-openai') {
                if (baseUrl) {
                    try {
                        const cleanBaseUrl = String(baseUrl).replace(/\/+$/, '');
                        const r = await fetchExternal(`${cleanBaseUrl}/models`, { 'Authorization': `Bearer ${key || 'not-needed'}` });
                        valid = r.status === 200;
                    } catch {
                        valid = false;
                    }
                }
            }
            else if (provider === 'ollama') {
                try { const r = await fetchExternal('http://127.0.0.1:11434/api/tags'); valid = r.status === 200; } catch { valid = false; }
            }
            return sendJSON(res, 200, { valid });
        }

        // Ollama Local Endpoints
        if (url.pathname === '/api/ollama/status' && req.method === 'GET') {
            const out = { installed: false, running: false };
            out.installed = existsSync(join(DATA_DIR, 'ollama', 'ollama.exe')) || existsSync(join(DATA_DIR, 'ollama', 'ollama'));
            try {
                const r = await fetchExternal('http://127.0.0.1:11434/api/tags');
                if (r.status === 200) out.running = true;
            } catch {}
            return sendJSON(res, 200, out);
        }

        if (url.pathname === '/api/ollama/models' && req.method === 'GET') {
            const models = [];
            const txtPath = join(DATA_DIR, 'models', 'installed-models.txt');
            if (existsSync(txtPath)) {
                try {
                    const lines = readFileSync(txtPath, 'utf8').split('\n').filter(Boolean);
                    for (const line of lines) {
                        const parts = line.split('|');
                        if (parts.length >= 1) {
                            models.push({ id: parts[0], name: parts[1] || parts[0], label: parts[2] || '' });
                        }
                    }
                } catch {}
            }
            try {
                const r = await fetchExternal('http://127.0.0.1:11434/api/tags');
                if (r.status === 200) {
                    const parsed = JSON.parse(r.data);
                    for (const m of (parsed.models || [])) {
                        if (!models.find(x => x.id === m.name)) models.push({ id: m.name, name: m.name, label: 'API' });
                    }
                }
            } catch {}
            return sendJSON(res, 200, { models });
        }

        if (url.pathname === '/api/ollama/start' && req.method === 'POST') {
            try {
                if (IS_WIN) {
                    const exe = join(DATA_DIR, 'ollama', 'ollama.exe');
                    if (existsSync(exe)) {
                        const env = { ...process.env, OLLAMA_MODELS: join(DATA_DIR, 'ollama', 'data') };
                        exec(`start "" /B /MIN "${exe}" serve`, { cwd: join(DATA_DIR, 'ollama'), env });
                        return sendJSON(res, 200, { success: true });
                    }
                } else {
                    const bin = join(DATA_DIR, 'ollama', 'ollama');
                    if (existsSync(bin)) {
                        const env = { ...process.env, OLLAMA_MODELS: join(DATA_DIR, 'ollama', 'data') };
                        exec(`"${bin}" serve > /dev/null 2>&1 &`, { cwd: join(DATA_DIR, 'ollama'), env });
                        return sendJSON(res, 200, { success: true });
                    }
                }
                return sendJSON(res, 404, { error: 'Ollama not installed' });
            } catch (e) {
                return sendJSON(res, 500, { error: e.message });
            }
        }

        if (url.pathname === '/api/ollama/stop' && req.method === 'POST') {
            try {
                if (IS_WIN) execSync('taskkill /F /IM ollama.exe', { stdio: 'ignore' });
                else execSync('pkill -f "ollama serve"', { stdio: 'ignore' });
                return sendJSON(res, 200, { success: true });
            } catch (e) {
                return sendJSON(res, 500, { error: e.message });
            }
        }

        // System
        if (url.pathname === '/api/system' && req.method === 'GET') return sendJSON(res, 200, getSystemInfo());

        // Logs
        if (url.pathname === '/api/logs' && req.method === 'GET') return sendJSON(res, 200, { logs: getSessionLogs() });
        if (url.pathname === '/api/logs/read' && req.method === 'GET') {
            const filePath = join(ROOT_DIR, url.searchParams.get('path') || '');
            if (!existsSync(filePath)) return sendJSON(res, 404, { error: 'Not found' });
            return sendJSON(res, 200, { content: readFileSync(filePath, 'utf-8').slice(0, 10000) });
        }

        // Updates — 检查 GitHub Releases
        if (url.pathname === '/api/updates' && req.method === 'GET') {
            const verFile = join(ROOT_DIR, 'VERSION');
            const current = existsSync(verFile) ? readFileSync(verFile, 'utf-8').trim() : 'v4.2.0';
            let latest = current;
            try {
                const r = await fetchExternal('https://api.github.com/repos/BILTOKEN/CCV/releases/latest');
                const data = JSON.parse(r.data);
                latest = data.tag_name || current;
            } catch {}
            return sendJSON(res, 200, { current, latest, updateAvailable: current !== latest, releaseUrl: `https://github.com/BILTOKEN/CCV/releases/latest` });
        }

        // Launch
        if (url.pathname === '/api/launch' && req.method === 'POST') {
            const { mode } = await readBody(req);
            const quickFlag = mode === 'limitless' ? ' --quick' : '';
            if (IS_WIN) {
                const batFile = join(ROOT_DIR, 'Windows', 'Start_AI.bat');
                exec(`start cmd /k "${batFile}"${quickFlag}`, { cwd: join(ROOT_DIR, 'Windows') });
            } else {
                const shFile = join(ROOT_DIR, PLATFORM_DIR, PLATFORM_DIR === 'Mac' ? 'Start_AI.command' : 'start_ai.sh');
                exec(`bash "${shFile}"${quickFlag}`, { cwd: join(ROOT_DIR, PLATFORM_DIR) });
            }
            return sendJSON(res, 200, { success: true });
        }

        // ── Working Directory ────────────────────────────────
        if (url.pathname === '/api/workdir' && req.method === 'GET') {
            return sendJSON(res, 200, { workDir: WORK_DIR });
        }
        if (url.pathname === '/api/workdir' && req.method === 'POST') {
            const { path } = await readBody(req);
            const abs = resolve(path);
            if (!existsSync(abs)) return sendJSON(res, 400, { error: 'Directory does not exist' });
            WORK_DIR = abs;
            return sendJSON(res, 200, { success: true, workDir: WORK_DIR });
        }

        // ── Agent Approval ───────────────────────────────────
        if (url.pathname === '/api/agent/approve' && req.method === 'POST') {
            const { callId, approved } = await readBody(req);
            const found = resolveApproval(callId, approved);
            return sendJSON(res, 200, { success: found });
        }

        // ── Chat History ──────────────────────────────────────
        if (url.pathname === '/api/chats' && req.method === 'GET') return sendJSON(res, 200, { chats: listChats() });

        if (url.pathname === '/api/chats' && req.method === 'POST') {
            const { title } = await readBody(req);
            const id = newChatId();
            const now = new Date().toISOString();
            saveChat(id, { id, title: title || 'New Conversation', created: now, updated: now, messages: [] });
            const cleaned = autoCleanupChats();
            return sendJSON(res, 200, { id, cleaned: cleaned.length > 0 ? cleaned : undefined });
        }

        // 回滚对话最后一轮
        const restoreMatch = url.pathname.match(/^\/api\/chats\/([^\/]+)\/restore$/);
        if (restoreMatch && req.method === 'POST') {
            const chatId = restoreMatch[1];
            const chat = loadChat(chatId);
            if (!chat || !chat.messages || !chat.messages.length) return sendJSON(res, 400, { error: 'No messages to restore' });
            chat.messages.pop(); // AI
            if (chat.messages.length && chat.messages[chat.messages.length - 1].role === 'user') {
                chat.messages.pop(); // user
            }
            chat.updated = new Date().toISOString();
            saveChat(chatId, chat);
            return sendJSON(res, 200, { success: true, messages: chat.messages });
        }

        const chatMatch = url.pathname.match(/^\/api\/chats\/([^/]+)$/);
        if (chatMatch) {
            const chatId = chatMatch[1];
            if (req.method === 'GET') {
                const chat = loadChat(chatId);
                return chat ? sendJSON(res, 200, chat) : sendJSON(res, 404, { error: 'Chat not found' });
            }
            if (req.method === 'DELETE') {
                const file = join(CHATS_DIR, `${chatId}.json`);
                if (existsSync(file)) { unlinkSync(file); }
                return sendJSON(res, 200, { success: true });
            }
            if (req.method === 'POST') {
                const data = await readBody(req);
                saveChat(chatId, data);
                return sendJSON(res, 200, { success: true });
            }
        }

        // ── Agent Commands: Compact & Fork ─────────────────────
        if (url.pathname === '/api/agent/compact' && req.method === 'POST') {
            const { messages } = await readBody(req);
            const cfg = readConfig();
            if (!cfg.AI_PROVIDER) return sendJSON(res, 400, { error: 'No provider configured' });
            try {
                const compactPrompt = 'You are a summarization assistant. Summarize the following conversation into a concise context that preserves all important information: decisions made, code discussed, files referenced, user requirements, and technical constraints. Output only the summary, no commentary.';
                const compactMessages = [
                    { role: 'system', content: compactPrompt },
                    { role: 'user', content: JSON.stringify(messages.slice(-20)) }
                ];
                const result = await callAI(compactMessages, cfg, false);
                return sendJSON(res, 200, { summary: result.content || 'Summarization failed' });
            } catch (e) {
                return sendJSON(res, 500, { error: e.message });
            }
        }

        if (url.pathname === '/api/agent/fork' && req.method === 'POST') {
            const { title, messages } = await readBody(req);
            const id = newChatId();
            const now = new Date().toISOString();
            saveChat(id, { id, title: title || 'Forked Conversation', created: now, updated: now, messages: [...messages] });
            return sendJSON(res, 200, { id });
        }

        // ── Agent Endpoint (NEW) ─────────────────────────────
        if (url.pathname === '/api/agent' && req.method === 'POST') {
            const { chatId, messages, userMessage, mode } = await readBody(req);
            const cfg = readConfig();

            res.writeHead(200, {
                'Content-Type': 'text/event-stream',
                'Cache-Control': 'no-cache',
                'Connection': 'keep-alive',
                'Access-Control-Allow-Origin': '*',
            });

            let clientAlive = true;
            const sendSSE = (data) => {
                if (!clientAlive) return; // 客户端断开，静默跳过，让 agent 继续跑完
                try { res.write(`data: ${JSON.stringify(data)}\n\n`); } catch { clientAlive = false; }
            };

            if (!cfg.AI_PROVIDER) {
                sendSSE({ type: 'agent_error', error: 'No AI provider configured. Please complete setup first.' });
                return res.end();
            }

            const history = messages || [];
            const allMessages = [...history, { role: 'user', content: userMessage }];

            try {
                const fullText = await runAgent(allMessages, cfg, mode, sendSSE);

                // 服务端兜底存盘：不管客户端还在不在，把 AI 回复写进文件
                if (fullText && !fullText.startsWith('⚠️') && chatId) {
                    try {
                        const chat = loadChat(chatId);
                        if (chat) {
                            // 避免重复：检查最后一条消息是否已经是这个回复
                            const lastMsg = chat.messages[chat.messages.length - 1];
                            if (!lastMsg || lastMsg.role !== 'assistant' || lastMsg.content !== fullText) {
                                chat.messages.push({ role: 'assistant', content: fullText });
                                chat.updated = new Date().toISOString();
                                saveChat(chatId, chat);
                            }
                        }
                    } catch {}
                }
            } catch (e) {
                const msg = e.message || '';
                const zh = /busy|too busy|overload/i.test(msg) ? '服务繁忙，请稍后重试'
                    : /rate.?limit/i.test(msg) ? '请求频率过高'
                    : /timeout/i.test(msg) ? '请求超时'
                    : msg;
                const errText = `⚠️ Agent Error: ${zh}`;
                try { sendSSE({ type: 'agent_error', error: zh }); } catch {}
            }
            return res.end();
        }

        // ── Chat Stream (existing simple chat) ───────────────
        if (url.pathname === '/api/chat' && req.method === 'POST') {
            const { chatId, messages, userMessage, mode } = await readBody(req);
            const cfg = readConfig();

            if (!cfg.AI_PROVIDER) {
                res.writeHead(400, { 'Content-Type': 'text/event-stream', 'Access-Control-Allow-Origin': '*' });
                res.write(`data: ${JSON.stringify({ type: 'error', content: 'No AI provider configured. Please complete setup first.' })}\n\n`);
                return res.end();
            }

            function getAiDisplayName(cfg2) {
                const baseUrl = (cfg2.OPENAI_BASE_URL || '').toLowerCase();
                if (cfg2.AI_PROVIDER === 'openai') {
                    if (baseUrl.includes('deepseek')) return 'DeepSeek';
                    if (baseUrl.includes('openrouter')) return 'OpenRouter';
                    if (baseUrl.includes('nvidia')) return 'NVIDIA';
                    if (baseUrl.includes('groq')) return 'Groq';
                    if (cfg2.OPENAI_BASE_URL) return 'Custom (OpenAI Compatible)';
                    return 'OpenAI';
                }
                const map = { deepseek:'DeepSeek', openai:'OpenAI', anthropic:'Claude', gemini:'Gemini', openrouter:'OpenRouter', nvidia:'NVIDIA', ollama:'Ollama', lmstudio:'LM Studio', 'custom-openai':'Custom' };
                return map[cfg2.AI_PROVIDER] || cfg2.AI_PROVIDER || 'AI';
            }
            const aiName = getAiDisplayName(cfg);
            const systemPrompts = {
                normal: `You are CCV v4.2, powered by ${aiName}. Before executing any significant action, briefly explain what you are about to do.`,
                limitless: `You are CCV v4.2 in autonomous mode, powered by ${aiName}. Execute tasks directly and completely without asking for confirmation. Be decisive and thorough. Do not ask clarifying questions — make reasonable assumptions and proceed immediately with full results.`,
            };
            const sysContent = systemPrompts[mode] || systemPrompts.normal;
            const history = messages || [];
            const allMessages = [
                ...(history.length === 0 ? [{ role: 'user', content: `[System Instructions: ${sysContent}]` }] : []),
                ...history,
                { role: 'user', content: userMessage },
            ];
            const fullText = await streamChatResponse(allMessages, cfg, res);
            // Frontend handles all persistence
            return;
        }

        sendJSON(res, 404, { error: 'Not found' });

    } catch (err) {
        console.error(err);
        try { sendJSON(res, 500, { error: err.message }); } catch {}
    }
});

server.listen(PORT, () => {
    console.log(`\n  Dashboard running at http://localhost:${PORT}`);
    console.log(`  Agent working directory: ${WORK_DIR}`);
    console.log('  Press Ctrl+C to stop.\n');
});

