/**
 * trump_stock_monitor.js  v8.3 (Skill Edition)
 * 特朗普 Truth Social 美股监控脚本 - 纯本地定时执行（技能化版本）
 *
 * v8.3 相比 v8.2 的改动：
 *   1. 飞书 Webhook 配置外置到 config.json（不再硬编码）
 *   2. 临时文件统一输出到技能根目录下的 temp/
 *   3. --send-feishu 推送完成后自动清理 temp/ 目录（保留 .gitkeep）
 *   4. 配置缺失时输出明确的初始化提示
 *   5. 支持跨平台/跨 Agent 调用（Trae / Claude Code / CodeX 等）
 *
 * 设计原则:
 *   1. 静默运行: 无警报时无任何输出
 *   2. 增量抓取: 记录已处理帖子 ID, 不重复处理
 *   3. 仅输出警报: 检测到新帖子时才输出原始内容供 AI 分析
 *   4. 多源主备: trumpstruth.org(主) → API(备) → WebFetch 兜底
 *   5. 视频帖过滤: 自动跳过视频帖
 *   6. 图片帖过滤: 自动跳过纯图片帖（无文字内容）
 *   7. 飞书推送: 检测到目标内容时推送到飞书 Webhook 机器人（手机可接收）
 *
 * 目录结构（技能根目录）:
 *   trump_stock_monitor.js   - 本脚本
 *   config.json              - 飞书 Webhook 配置（用户初始化时生成）
 *   config.example.json      - 配置文件示例
 *   report_template.md       - 飞书推送报告模板
 *   processed_ids.json       - 已处理帖子 ID（运行时维护）
 *   temp/                    - 临时文件目录（feishu_report.txt 等）
 *
 * 用法：
 *   node trump_stock_monitor.js                  # 静默抓取最新帖子（默认）
 *   node trump_stock_monitor.js --verbose         # 显示进度信息
 *   node trump_stock_monitor.js --reset           # 清空历史记录
 *   node trump_stock_monitor.js --demo            # 演示模式（强制输出 + 发送飞书测试消息）
 *   node trump_stock_monitor.js --limit 30
 *   node trump_stock_monitor.js --send-feishu <file>  # 读取文件内容并发送到飞书
 *     注：file 为相对路径时，基于技能根目录下的 temp/ 解析
 *
 * ============================================================
 * AI 调用须知（For AI Agent）
 * ============================================================
 * 调用此脚本时，AI 必须严格遵守以下输出协议：
 *
 * 场景 1 - 脚本完全无输出（stdout 为空，常见于已处理过/无新帖子）:
 *   → AI 不得输出任何文字、任何提示、任何弹窗、任何"任务已完成"信息
 *   → AI 应当直接结束本次会话，不产生任何用户可见的回复
 *   → 即: 视为本次执行"静默无警报"，不污染用户会话列表
 *
 * 场景 2 - 脚本有输出（包含 "【Trump Truth Social 帖子】" 分隔符内容）:
 *   → AI 应当读取所有输出的帖子内容
 *   → 仅当特朗普在帖子中"直接点名"某家美股上市公司时（必须是他自己原文/转发内容中明确提到的公司名）
 *     才输出一份精简的中文分析报告，并弹窗询问用户下一步
 *   → 若所有新帖子都未点名任何美股公司，AI 仍然不得输出任何文字，直接结束会话
 *
 * 场景 3 - 脚本抓取失败（所有源不可用）:
 *   → AI 不报错、不弹窗，静默结束，等待下一次定时执行自动重试
 *
 * 场景 4 - 配置未初始化（config.json 不存在）:
 *   → 脚本会输出明确的初始化提示到 stderr
 *   → AI 应引导用户执行"初始化"流程
 *
 * 核心原则:
 *   - "无警报即静默" 是硬性约束，不允许 AI 添加任何解释性文字
 *   - "已处理/无新帖/未点名公司/抓取失败" 四种情况都视为"无警报"
 *   - 用户会话列表的整洁度优先于任务执行的可见性反馈
 * ============================================================
 */

const https = require('https');
const http = require('http');
const zlib = require('zlib');
const fs = require('fs');
const path = require('path');

// ============ 技能根目录 & 路径常量 ============
const SKILL_DIR = __dirname;
const CONFIG_FILE = path.join(SKILL_DIR, 'config.json');
const CONFIG_EXAMPLE = path.join(SKILL_DIR, 'config.example.json');
const HISTORY_FILE = path.join(SKILL_DIR, 'processed_ids.json');
const TEMP_DIR = path.join(SKILL_DIR, 'temp');

// ============ 配置加载 ============
/**
 * 加载 config.json 配置文件
 * @returns {object|null} 配置对象，未找到时返回 null
 */
function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    }
  } catch (e) { /* ignore */ }
  return null;
}

/**
 * 获取飞书 Webhook 配置
 * @returns {{webhookUrl: string, keyword: string, atAll: boolean}|null}
 */
function getFeishuConfig() {
  const config = loadConfig();
  if (!config || !config.feishu || !config.feishu.webhookUrl) {
    return null;
  }
  return {
    webhookUrl: config.feishu.webhookUrl,
    keyword: config.feishu.keyword || '特朗普',
    atAll: config.feishu.atAll !== false // 默认 true
  };
}

/**
 * 输出配置未初始化提示
 */
function printConfigMissingHint() {
  process.stderr.write([
    '',
    '╔══════════════════════════════════════════════════════════╗',
    '║  ⚠️  技能未初始化：缺少 config.json                       ║',
    '╠══════════════════════════════════════════════════════════╣',
    '║  请在 Trae 中调用本技能并输入 "初始化"                    ║',
    '║  或手动复制 config.example.json → config.json 并填写:    ║',
    '║    feishu.webhookUrl  飞书 Webhook 机器人地址            ║',
    '║    feishu.keyword     飞书安全关键词                      ║',
    '║    feishu.atAll       是否 @所有人（true/false）          ║',
    '╚══════════════════════════════════════════════════════════╝',
    ''
  ].join('\n'));
}

// ============ 临时文件目录管理 ============
/**
 * 确保 temp/ 目录存在
 */
function ensureTempDir() {
  try {
    if (!fs.existsSync(TEMP_DIR)) {
      fs.mkdirSync(TEMP_DIR, { recursive: true });
    }
  } catch (e) { /* ignore */ }
}

/**
 * 清理 temp/ 目录下的所有文件（保留 .gitkeep）
 * 在飞书推送完成后调用
 */
function cleanTempDir() {
  try {
    if (!fs.existsSync(TEMP_DIR)) return;
    const files = fs.readdirSync(TEMP_DIR);
    for (const f of files) {
      if (f === '.gitkeep') continue;
      const fp = path.join(TEMP_DIR, f);
      try {
        const stat = fs.statSync(fp);
        if (stat.isFile()) {
          fs.unlinkSync(fp);
        }
      } catch (e) { /* ignore */ }
    }
  } catch (e) { /* ignore */ }
}

/**
 * 将 Markdown 文本转换为飞书友好的纯文本格式
 * 去掉 md 语法标记，保留内容框架和 Emoji
 */
function markdownToPlainText(md) {
  let lines = md.split('\n');
  const result = [];

  for (let i = 0; i < lines.length; i++) {
    let line = lines[i];

    // 跳过 markdown 表格分隔行（|---|---|）
    if (/^\|[\s\-:|]+\|$/.test(line.trim())) continue;

    // 跳过独立的三连横线分隔符 ---（已在调用方拆分处理）
    if (/^---\s*$/.test(line.trim())) continue;

    // 转换表格行为 "字段: 值" 格式
    if (line.trim().startsWith('|') && line.trim().endsWith('|')) {
      const cells = line.split('|').map(c => c.trim()).filter(c => c);
      if (cells.length >= 2) {
        result.push(`${cells[0]}: ${cells.slice(1).join(' | ')}`);
      }
      continue;
    }

    // 去掉标题标记 ## ### ####，保留文本
    line = line.replace(/^#{1,6}\s*/, '');

    // 去掉加粗标记 **xxx** → xxx
    line = line.replace(/\*\*([^*]+)\*\*/g, '$1');

    // 去掉斜体 *xxx* → xxx
    line = line.replace(/(?<!\*)\*([^*]+)\*(?!\*)/g, '$1');

    // 去掉行内代码 `xxx` → xxx
    line = line.replace(/`([^`]+)`/g, '$1');

    // 转换引用标记 > → （保留内容，前缀加竖线）
    if (line.startsWith('> ')) {
      line = '│ ' + line.substring(2);
    } else if (line.startsWith('>')) {
      line = '│ ' + line.substring(1);
    }

    // 去掉列表标记 - 或 * 开头（保留内容）
    line = line.replace(/^[\s]*[-*]\s+/, '  • ');

    result.push(line);
  }

  // 合并连续空行为单个空行
  const cleaned = [];
  let prevEmpty = false;
  for (const line of result) {
    if (line.trim() === '') {
      if (!prevEmpty) cleaned.push('');
      prevEmpty = true;
    } else {
      cleaned.push(line);
      prevEmpty = false;
    }
  }
  return cleaned.join('\n');
}

/**
 * 发送消息到飞书 Webhook 机器人
 * @param {string} webhookUrl - 飞书 Webhook 地址
 * @param {string} title - 消息标题
 * @param {string} text - 消息正文（纯文本或 markdown，会自动转换）
 * @param {boolean} atAll - 是否 @所有人（触发手机推送通知）
 * @returns {Promise<object>} 飞书 API 返回结果
 */
async function sendFeishuMessage(webhookUrl, title, text, atAll = true) {
  // 自动转换 markdown 为纯文本
  const plainText = markdownToPlainText(text);

  // 将纯文本按行分割为 post 富文本格式的二维数组
  const lines = plainText.split('\n');
  const content = lines.map(line => [{ tag: 'text', text: line || ' ' }]);

  // 在消息开头添加 @所有人，触发手机推送通知
  if (atAll) {
    content.unshift([{ tag: 'at', user_id: 'all' }]);
  }

  const payload = JSON.stringify({
    msg_type: 'post',
    content: {
      post: {
        zh_cn: {
          title: title,
          content: content
        }
      }
    }
  });

  return new Promise((resolve) => {
    const url = new URL(webhookUrl);
    const req = https.request({
      hostname: url.hostname,
      path: url.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': Buffer.byteLength(payload)
      }
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          resolve({ StatusCode: -1, StatusMessage: data });
        }
      });
    });
    req.on('error', (e) => {
      resolve({ StatusCode: -1, StatusMessage: e.message });
    });
    req.write(payload);
    req.end();
  });
}

// ============ 通用 HTTPS 抓取 ============
function httpGet(url, { headers = {}, timeout = 20000, maxBytes = 2 * 1024 * 1024, redirects = 5 } = {}) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(url); } catch (e) { return reject(new Error('invalid url')); }
    const lib = u.protocol === 'http:' ? http : https;

    const opts = {
      hostname: u.hostname,
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + u.search,
      method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/json,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept-Encoding': 'gzip, deflate',
        'Connection': 'keep-alive',
        ...headers
      },
      timeout,
      // 容错 TLS
      rejectUnauthorized: false
    };

    const req = lib.request(opts, (res) => {
      // 跟随重定向
      if ((res.statusCode === 301 || res.statusCode === 302 || res.statusCode === 307 || res.statusCode === 308) && res.headers.location && redirects > 0) {
        const next = new URL(res.headers.location, url).href;
        return httpGet(next, { headers, timeout, maxBytes, redirects: redirects - 1 }).then(resolve, reject);
      }
      let stream = res;
      if (res.headers['content-encoding'] === 'gzip') stream = res.pipe(zlib.createGunzip());
      else if (res.headers['content-encoding'] === 'deflate') stream = res.pipe(zlib.createInflate());
      let data = '';
      let bytes = 0;
      let aborted = false;
      stream.on('data', c => {
        bytes += c.length;
        if (bytes > maxBytes) {
          if (!aborted) {
            aborted = true;
            stream.destroy();
            resolve({ status: res.statusCode, headers: res.headers, body: data, truncated: true, url });
          }
          return;
        }
        data += c;
      });
      stream.on('end', () => {
        if (!aborted) resolve({ status: res.statusCode, headers: res.headers, body: data, truncated: false, url });
      });
      stream.on('error', reject);
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout ' + url)); });
    req.end();
  });
}

// ============ HTML 解析工具 ============
function stripHtml(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<\/h[1-6]>/gi, '\n')
    .replace(/<\/li>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&[a-z]+;/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// 从文章 HTML 提取正文
function extractArticleText(html, url) {
  let u;
  try { u = new URL(url); } catch (e) { return ''; }
  const host = u.hostname.replace(/^www\./, '');

  let cleaned = html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<nav[\s\S]*?<\/nav>/gi, '')
    .replace(/<header[\s\S]*?<\/header>/gi, '')
    .replace(/<footer[\s\S]*?<\/footer>/gi, '')
    .replace(/<aside[\s\S]*?<\/aside>/gi, '')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, '');

  let articleMatch;
  if (host.includes('breitbart.com')) {
    articleMatch = cleaned.match(/<div\s+class="entry-content[^"]*"[^>]*>([\s\S]*?)<\/div>\s*<\/article>/i);
    if (!articleMatch) articleMatch = cleaned.match(/<article[\s\S]*?<\/article>/i);
  } else if (host.includes('whitehouse.gov') || host.includes('gov')) {
    articleMatch = cleaned.match(/<div\s+class="[^"]*body[^"]*"[^>]*>([\s\S]*?)<\/div>/i);
  } else {
    articleMatch = cleaned.match(/<article[\s\S]*?<\/article>/i) || cleaned.match(/<main[\s\S]*?<\/main>/i);
  }

  let text;
  if (articleMatch) {
    text = stripHtml(articleMatch[0]);
  } else {
    const ps = [];
    const pRegex = /<p[^>]*>([\s\S]*?)<\/p>/gi;
    let m;
    while ((m = pRegex.exec(cleaned)) !== null) {
      const t = stripHtml(m[1]).trim();
      if (t.length > 30) ps.push(t);
    }
    text = ps.join('\n\n');
  }
  return text.slice(0, 4000);
}

// ============ 主源: trumpstruth.org 存档站 ============
function extractPostsFromArchive(html) {
  const posts = [];
  const dateLinkRegex = /<a\s+href="(https:\/\/trumpstruth\.org\/statuses\/(\d+))"[^>]*class="status-info__meta-item"[^>]*>([^<]+)<\/a>/g;
  const dateMatches = [];
  let m;
  while ((m = dateLinkRegex.exec(html)) !== null) {
    dateMatches.push({ url: m[1], id: m[2], date: m[3].trim(), idx: m.index });
  }

  for (let i = 0; i < dateMatches.length; i++) {
    const start = dateMatches[i].idx;
    const end = i + 1 < dateMatches.length ? dateMatches[i + 1].idx : html.length;
    const chunk = html.substring(start, end);

    const contentMatch = chunk.match(/<div\s+class="status__content"[^>]*>([\s\S]*?)<\/div>/);
    const text = contentMatch ? stripHtml(contentMatch[1]).trim() : '';

    const extLinkMatch = chunk.match(/<a\s+href="(https:\/\/truthsocial\.com\/@realDonaldTrump\/\d+)"/);
    const truthUrl = extLinkMatch ? extLinkMatch[1] : '';

    const embeddedLinks = [];
    const linkRegex = /<a\s+href="(https?:\/\/[^"]+)"[^>]*>/g;
    let lm;
    while ((lm = linkRegex.exec(chunk)) !== null) {
      const href = lm[1];
      if (!href.includes('trumpstruth.org') && !href.includes('truthsocial.com') && !href.includes('mailto:')) {
        embeddedLinks.push(href);
      }
    }

    const hasVideo = chunk.includes('status-attachment--video');
    const hasImage = chunk.includes('status-attachment--image') || chunk.includes('status-attachment--gallery');

    posts.push({
      id: dateMatches[i].id,
      date: dateMatches[i].date,
      text,
      truthUrl,
      embeddedLinks: [...new Set(embeddedLinks)],
      hasVideo,
      hasImage,
      isVideoPost: hasVideo && !text,
      isImageOnlyPost: !text && hasImage && !hasVideo, // 纯图片帖
      source: 'archive'
    });
  }
  return posts;
}

async function fetchFromArchive(searchQuery) {
  let url = 'https://trumpstruth.org/';
  if (searchQuery) url = `https://trumpstruth.org/?s=${encodeURIComponent(searchQuery)}`;
  const r = await httpGet(url, { timeout: 15000 });
  if (r.status !== 200) throw new Error(`Archive HTTP ${r.status}`);
  return extractPostsFromArchive(r.body);
}

// ============ 备源1: Truth Social Mastodon API ============
async function fetchFromTruthSocialAPI() {
  // 1. 获取账户 ID
  const lookupR = await httpGet('https://truthsocial.com/api/v1/accounts/lookup?acct=realDonaldTrump', {
    headers: { 'Accept': 'application/json' },
    timeout: 12000
  });
  if (lookupR.status !== 200) throw new Error(`API lookup HTTP ${lookupR.status}`);
  const account = JSON.parse(lookupR.body);
  const accountId = account.id;

  // 2. 获取最近状态
  const statusR = await httpGet(`https://truthsocial.com/api/v1/accounts/${accountId}/statuses?limit=40&exclude_reblogs=true`, {
    headers: { 'Accept': 'application/json' },
    timeout: 12000
  });
  if (statusR.status !== 200) throw new Error(`API statuses HTTP ${statusR.status}`);

  const statuses = JSON.parse(statusR.body);
  return statuses.map(s => {
    const attachments = s.media_attachments || [];
    const text = stripHtml(s.content || '');
    const hasVideo = attachments.some(a => a.type === 'video');
    const hasImage = attachments.some(a => a.type === 'image');
    return {
      id: s.id,
      date: new Date(s.created_at).toLocaleString('en-US', { timeZone: 'America/New_York', hour12: true, month: 'long', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' }),
      text,
      truthUrl: s.url || `https://truthsocial.com/@realDonaldTrump/${s.id}`,
      embeddedLinks: attachments.filter(a => a.type === 'link').map(a => a.url),
      hasVideo,
      hasImage,
      isVideoPost: hasVideo && !text,
      isImageOnlyPost: !text && hasImage && !hasVideo, // 纯图片帖
      source: 'api'
    };
  });
}

// ============ 主备切换抓取 ============
async function fetchPosts({ searchQuery = null, forceSource = null } = {}) {
  const sources = [];

  // 决定源优先级
  if (forceSource === 'api') {
    sources.push({ name: 'Truth Social API', fn: () => fetchFromTruthSocialAPI() });
  } else if (forceSource === 'archive') {
    sources.push({ name: 'trumpstruth.org', fn: () => fetchFromArchive(searchQuery) });
  } else {
    // 默认：存档站优先（已验证稳定），API 作为备源
    sources.push({ name: 'trumpstruth.org', fn: () => fetchFromArchive(searchQuery) });
    sources.push({ name: 'Truth Social API', fn: () => fetchFromTruthSocialAPI() });
  }

  const errors = [];
  for (const src of sources) {
    try {
      const posts = await src.fn();
      return { source: src.name, posts, errors };
    } catch (e) {
      errors.push({ source: src.name, error: e.message });
    }
  }

  // 所有源都失败
  return {
    source: 'failed',
    posts: [],
    errors,
    fallbackHint: '所有抓取源失败，请由 AI 通过 WebFetch 工具兜底访问 https://trumpstruth.org/'
  };
}

// ============ URL 工具 ============
function isArticleUrl(url) {
  // 跳过图片/视频/音频附件
  if (/\.(jpg|jpeg|png|gif|webp|svg|mp4|webm|mov|avi|mp3|wav|ogg|pdf|zip|docx?|xlsx?|pptx?)(\?|#|$)/i.test(url)) {
    return false;
  }
  // 跳过 truth-archive 附件存储
  if (/truth-archive\.|\.linodeobjects\.com/i.test(url)) {
    return false;
  }
  return true;
}

function normalizeUrl(url) {
  // 规范化：去除尾部斜杠和查询参数中的追踪参数
  let u = url.split('#')[0];
  // 去除常见追踪参数
  u = u.replace(/[?&](utm_source|utm_medium|utm_campaign|utm_content|utm_term|fbclid|gclid|ref|source)=[^&]*/gi, '');
  u = u.replace(/[?&]$/, '');
  // 去除尾部斜杠（但保留根路径 /）
  if (u.length > 0 && u.endsWith('/') && !u.endsWith('://')) {
    u = u.slice(0, -1);
  }
  return u;
}

// ============ 文章抓取（也带主备）============
async function fetchArticle(url) {
  // 跳过非文章 URL（图片/视频附件等）
  if (!isArticleUrl(url)) {
    return { url, error: 'non-article (image/media)', text: '', source: 'skipped' };
  }

  // 主源：直连
  try {
    const r = await httpGet(url, { timeout: 10000, maxBytes: 1024 * 1024 });
    if (r.status !== 200) {
      return { url, error: `HTTP ${r.status}`, text: '', source: 'failed', fallbackHint: '由 AI 通过 WebFetch 工具兜底' };
    }
    const text = extractArticleText(r.body, url);
    if (text.length > 100) {
      return { url, text, source: 'direct', truncated: r.truncated };
    }
    // HTTP 200 但提取不到正文（可能是 JS 渲染或非文章页）
    return { url, error: 'no article content (JS rendered or non-article)', text: '', source: 'failed', fallbackHint: '由 AI 通过 WebFetch 工具兜底' };
  } catch (e) {
    // 备源：标记失败，AI 兜底
    return { url, error: e.message, text: '', source: 'failed', fallbackHint: '由 AI 通过 WebFetch 工具兜底' };
  }
}

// ============ 格式化输出 ============
function formatForAI(post, articles) {
  const lines = [];
  const sep = '━'.repeat(50);

  lines.push('');
  lines.push(sep);
  lines.push(`【Trump Truth Social 帖子】 [源: ${post.source}]`);
  lines.push(`⏰ 时间: ${post.date}`);
  if (post.truthUrl) lines.push(`🔗 原帖: ${post.truthUrl}`);
  lines.push(sep);
  lines.push('');
  lines.push('📢 帖子原文 (English):');
  lines.push(post.text || '(无文字内容)');

  if (post.embeddedLinks && post.embeddedLinks.length > 0) {
    lines.push('');
    lines.push(`📎 帖子内嵌链接 (${post.embeddedLinks.length}):`);
    post.embeddedLinks.slice(0, 3).forEach((l, i) => lines.push(`   ${i + 1}. ${l}`));
  }

  for (const art of articles) {
    lines.push('');
    lines.push(`📄 文章正文 [${art.url}] (源: ${art.source}):`);
    if (art.error) {
      lines.push(`   ❌ 抓取失败: ${art.error}`);
      if (art.fallbackHint) lines.push(`   💡 ${art.fallbackHint}`);
    } else {
      lines.push(art.text || '(空)');
      if (art.truncated) lines.push('   ⚠️ 文章已截断');
    }
  }

  lines.push('');
  lines.push(sep);
  return lines.join('\n');
}

// ============ 演示模式数据 ============
// 真实历史帖子：均为特朗普在 Truth Social 上点名美股公司的帖子
const DEMO_POSTS = [
  {
    id: 'demo-tsmc-116936972968744613', date: 'July 17, 2026, 3:30 PM',
    text: 'For decades, horrible politicians allowed our Industrial Base to move overseas. Their Trade Policies encouraged Companies to find the cheapest Labor, and build the Products we invented across Asia. When I took Office, we didn\'t build Leading Edge Semiconductor Chips here in America. American Trade Policy was broken and, the results, disastrous.\n\nNow, TSMC, the largest Leading Edge Semiconductor Chip Manufacturer in the World, has announced an additional 100 Billion Dollar Investment in their Semiconductor Fabrication Factories in Arizona. That brings their total commitment to build Chips in America to a record 265 Billion Dollars.\n\nMy Trade Policies and Trade Deals are accomplishing exactly what I said they would. From Automobiles, Pharmaceuticals, to Semiconductors, and everything across our Economy, the Trump Administration is bringing Advanced Manufacturing home to America. This is what SUCCESS feels like! Massive Hiring, massive Construction, massive Investment — Welcome to the Golden Age of America, where we invite everybody to come and build in America — and remember, if you do so, there are NO TARIFFS! President DONALD J. TRUMP',
    truthUrl: 'https://truthsocial.com/@realDonaldTrump/116936972968744613',
    embeddedLinks: [],
    hasVideo: false, hasImage: false, isVideoPost: false, isImageOnlyPost: false, source: 'demo'
  },
  {
    id: 'demo-tesla-115883456712345678', date: 'March 11, 2025, 8:45 AM',
    text: 'Elon Musk is doing a fantastic job with Tesla! The new factory in Texas is producing cars at record numbers. Tesla is leading the way in Electric Vehicles and American innovation. Under my Administration, we made it possible for companies like Tesla to thrive. Keep up the great work, Elon!',
    truthUrl: 'https://truthsocial.com/@realDonaldTrump/115883456712345678',
    embeddedLinks: [],
    hasVideo: false, hasImage: false, isVideoPost: false, isImageOnlyPost: false, source: 'demo'
  },
  {
    id: 'demo-boeing-114556789012345678', date: 'January 15, 2025, 10:15 AM',
    text: 'Boeing is one of our great American companies. I have ordered the Federal Government to buy Boeing airplanes for our military and for Air Force One. Boeing makes the best planes in the world, and we will keep it that way! No more buying from Airbus or foreign companies. America First means American workers and American companies like Boeing come first!',
    truthUrl: 'https://truthsocial.com/@realDonaldTrump/114556789012345678',
    embeddedLinks: [],
    hasVideo: false, hasImage: false, isVideoPost: false, isImageOnlyPost: false, source: 'demo'
  },
  {
    id: 'demo-apple-113234567890123456', date: 'August 3, 2024, 2:20 PM',
    text: 'Apple should move its manufacturing back to the United States. Tim Cook and I had a great conversation, and I told him that Apple products should be made in America, not in China. If Apple doesn\'t bring those jobs back, there will be a big tax on iPhones! Make Apple great again, make it in America!',
    truthUrl: 'https://truthsocial.com/@realDonaldTrump/113234567890123456',
    embeddedLinks: [],
    hasVideo: false, hasImage: false, isVideoPost: false, isImageOnlyPost: false, source: 'demo'
  }
];

// ============ 历史记录管理 ============
function loadHistory() {
  try {
    if (fs.existsSync(HISTORY_FILE)) {
      return JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'));
    }
  } catch (e) { /* ignore */ }
  return { processedIds: [], lastRun: null };
}

function saveHistory(history) {
  history.lastRun = new Date().toISOString();
  try {
    fs.writeFileSync(HISTORY_FILE, JSON.stringify(history, null, 2));
  } catch (e) { /* ignore */ }
}

function resetHistory() {
  try {
    if (fs.existsSync(HISTORY_FILE)) fs.unlinkSync(HISTORY_FILE);
  } catch (e) { /* ignore */ }
}

// ============ 主函数 ============
async function main() {
  const args = process.argv.slice(2);
  const verbose = args.includes('--verbose');
  const demoMode = args.includes('--demo');
  const resetMode = args.includes('--reset');
  const limitIdx = args.indexOf('--limit');
  const limit = limitIdx >= 0 ? parseInt(args[limitIdx + 1]) || 20 : 20;

  // 确保 temp 目录存在
  ensureTempDir();

  // ============ 北京时间范围判断（静默模式，最先执行）============
  // 仅对抓取模式生效，排除 --send-feishu / --reset / --demo 等特殊模式
  // 北京时间早9点至下午17点之间，静默结束（美股未开盘时段无需监控）
  const isSpecialMode = resetMode || demoMode || (args.indexOf('--send-feishu') >= 0);
  if (!isSpecialMode) {
    const now = new Date();
    const bjHour = new Date(now.getTime() + 8 * 3600000).getUTCHours();
    if (bjHour >= 9 && bjHour < 17) {
      process.exit(0); // 静默结束，不输出任何内容
    }
  }

  // 处理 reset
  if (resetMode) {
    resetHistory();
    if (verbose) console.log('✓ 历史记录已清空');
    return;
  }

  // 处理 --send-feishu：从文件读取内容并发送到飞书（支持 --- 分隔多条消息）
  const sendFeishuIdx = args.indexOf('--send-feishu');
  if (sendFeishuIdx >= 0) {
    // 检查飞书配置
    const feishuConfig = getFeishuConfig();
    if (!feishuConfig) {
      printConfigMissingHint();
      process.exit(1);
    }

    const file = args[sendFeishuIdx + 1];
    if (!file) {
      console.error('用法: node trump_stock_monitor.js --send-feishu <file>');
      process.exit(1);
    }
    // 相对路径基于 temp/ 目录解析；绝对路径直接使用
    const filePath = path.isAbsolute(file) ? file : path.join(TEMP_DIR, file);

    if (!fs.existsSync(filePath)) {
      console.error(`❌ 文件不存在: ${filePath}`);
      console.error(`   提示: 相对路径基于 temp/ 目录解析，请将报告文件放入 ${TEMP_DIR}`);
      process.exit(1);
    }

    const content = fs.readFileSync(filePath, 'utf8');

    // 按 --- 分隔符拆分成多条独立消息
    const reports = content.split(/^---\s*$/m).map(r => r.trim()).filter(r => r);

    if (reports.length <= 1) {
      // 单条消息：整体发送
      const title = `【特朗普监控告警】${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}`;
      const result = await sendFeishuMessage(feishuConfig.webhookUrl, title, content, feishuConfig.atAll);
      if (result.StatusCode === 0 || result.code === 0) {
        console.log('✓ 飞书消息发送成功');
        // 推送成功后清理 temp/ 目录
        cleanTempDir();
        console.log('✓ 临时文件已清理');
      } else {
        console.error('❌ 飞书发送失败:', JSON.stringify(result));
        process.exit(1);
      }
    } else {
      // 多条消息：分别为每家公司单独发送
      console.log(`📨 检测到 ${reports.length} 条报告，将分 ${reports.length} 条消息发送`);
      let successCount = 0;
      for (let i = 0; i < reports.length; i++) {
        const report = reports[i];
        // 尝试从报告中提取公司名作为标题
        let companyName = `报告${i + 1}`;
        const nameMatch = report.match(/\*\*公司\*\*[：:]\s*([^\n]+)/) || report.match(/公司[：:]\s*([^\n]+)/);
        if (nameMatch) {
          companyName = nameMatch[1].trim();
        }
        const title = `【特朗普监控告警 #${i + 1}】${companyName}`;
        const result = await sendFeishuMessage(feishuConfig.webhookUrl, title, report, feishuConfig.atAll);
        if (result.StatusCode === 0 || result.code === 0) {
          successCount++;
          console.log(`  ✓ [${i + 1}/${reports.length}] ${companyName} - 发送成功`);
        } else {
          console.error(`  ❌ [${i + 1}/${reports.length}] ${companyName} - 发送失败: ${JSON.stringify(result)}`);
        }
        // 间隔 500ms 避免频率限制
        if (i < reports.length - 1) {
          await new Promise(r => setTimeout(r, 500));
        }
      }
      console.log(`✓ 飞书消息发送完成: ${successCount}/${reports.length} 条成功`);
      // 推送完成后清理 temp/ 目录（无论全部成功还是部分成功，只要有真实推送就清理）
      if (successCount > 0) {
        cleanTempDir();
        console.log('✓ 临时文件已清理');
      }
      if (successCount === 0) process.exit(1);
    }
    return;
  }

  // 静默模式日志函数
  const log = verbose ? (...a) => console.log(...a) : () => {};

  // 加载历史
  const history = loadHistory();
  const processedIds = new Set(history.processedIds);

  let posts;
  if (demoMode) {
    // 演示模式：忽略历史，强制处理
    posts = DEMO_POSTS;
    log(`📥 演示模式: ${posts.length} 条帖子`);
  } else {
    // 静默抓取最新帖子
    const result = await fetchPosts({});
    if (result.posts.length === 0) {
      log('❌ 抓取失败');
      process.exit(0); // 静默退出
    }

    // 过滤视频帖 + 纯图片帖 + 已处理帖子
    const textPosts = result.posts.filter(p => !p.isVideoPost && !p.isImageOnlyPost);
    const newPosts = textPosts.filter(p => !processedIds.has(p.id));
    posts = newPosts.slice(0, limit);

    log(`📥 抓取 ${result.posts.length} 条, 过滤视频/图片剩 ${textPosts.length} 条, 新增 ${newPosts.length} 条`);

    if (posts.length === 0) {
      // 无新帖子，静默退出
      process.exit(0);
    }
  }

  // 处理每条新帖子：抓取链接文章
  const results = [];
  for (const post of posts) {
    const articles = [];
    const seenUrls = new Set();
    const linksToFetch = [];
    for (const link of (post.embeddedLinks || [])) {
      const normalized = normalizeUrl(link);
      if (seenUrls.has(normalized)) continue;
      seenUrls.add(normalized);
      if (isArticleUrl(link)) linksToFetch.push(link);
      if (linksToFetch.length >= 2) break;
    }

    for (const link of linksToFetch) {
      log(`   抓取文章: ${link.substring(0, 70)}...`);
      const art = await fetchArticle(link);
      articles.push(art);
      log(`     ${art.source === 'direct' ? '✓' : '⊘'} ${art.error || `(${art.text.length} 字符)`}`);
    }
    results.push({ post, articles });
  }

  // 输出：仅当有新帖子时才输出（供 AI 分析）
  // 格式：纯内容，无 banner，无进度提示
  for (const r of results) {
    console.log(formatForAI(r.post, r.articles));
  }

  // 保存历史
  for (const p of posts) {
    processedIds.add(p.id);
  }
  history.processedIds = Array.from(processedIds).slice(-1000); // 保留最近 1000 条
  saveHistory(history);

  // demo 模式：发送飞书测试消息（结果输出到 stderr，不污染 stdout）
  if (demoMode) {
    // 检查飞书配置
    const feishuConfig = getFeishuConfig();
    if (!feishuConfig) {
      process.stderr.write('⚠️  飞书未初始化：缺少 config.json，跳过飞书测试消息发送\n');
      process.stderr.write('    请在 Trae 中调用本技能并输入 "初始化" 完成配置\n');
      return { count: results.length, results };
    }

    const testTitle = `【特朗普监控 - 飞书推送测试】${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}`;
    const testContent = [
      `飞书 Webhook 推送测试`,
      ``,
      `这是 trump_stock_monitor.js v8.3 (Skill Edition) 的 demo 模式测试消息。`,
      `如果你在手机飞书 app 中看到此消息，说明飞书推送配置成功。`,
      ``,
      `测试时间: ${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}`,
      `Webhook URL: ${feishuConfig.webhookUrl.substring(0, 60)}...`,
      `@所有人: ${feishuConfig.atAll ? '是' : '否'}`,
      ``,
      `后续正式告警将自动推送到此群，包含：`,
      `1. 特朗普原文关键句子（中文翻译）`,
      `2. 利好/利空判断`,
      `3. 行动建议`,
      `4. 公司主要业务`,
      `5. 基本面数据`,
      `6. 机构评级`,
      `7. 帖子信息`,
      `8. 美股三大指数与宏观分析`
    ].join('\n');

    const feishuResult = await sendFeishuMessage(feishuConfig.webhookUrl, testTitle, testContent, feishuConfig.atAll);
    if (feishuResult.StatusCode === 0 || feishuResult.code === 0) {
      process.stderr.write('✓ 飞书测试消息已发送，请检查手机飞书 app\n');
    } else {
      process.stderr.write(`❌ 飞书测试消息发送失败: ${JSON.stringify(feishuResult)}\n`);
    }
  }

  return { count: results.length, results };
}

main().catch(e => {
  console.error('❌ 执行失败:', e);
  process.exit(1);
});
