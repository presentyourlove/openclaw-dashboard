#!/usr/bin/env node
/**
 * OpenClaw Monitor V4.1.1 - Dashboard Service (V2.1 Architecture)
 * - 獲取模型額度 (openclaw models) - Strip ANSI colors
 * - 獲取活躍 sessions (openclaw sessions --json)
 * - 監控 tasks/inbox/ (Queue & Router 支援)
 * - Health Check 自動告警
 * - 推送至 Firestore
 */

const https = require('https');
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { exec } = require('child_process');

const sleep = ms => new Promise(r => setTimeout(r, ms));

// 手動讀取 .env
function loadEnv() {
  const envPath = path.join(__dirname, '../../.env');
  try {
    const content = fs.readFileSync(envPath, 'utf8');
    content.split('\n').forEach(line => {
      const [key, ...vals] = line.split('=');
      if (key && vals.length) {
        process.env[key.trim()] = vals.join('=').trim();
      }
    });
  } catch (err) {
    console.error('無法讀取 .env 文件:', err.message);
    process.exit(1);
  }
}

loadEnv();

const PROJECT_ID = process.env.FIREBASE_PROJECT_ID;
const API_KEY = process.env.FIREBASE_API_KEY;
const INTERVAL_MS = 10000;
const INBOX_PATH = path.join(__dirname, '../../tasks/inbox');
const WORKSPACE_PATH = path.join(__dirname, '../..');

// Health Check 狀態
let consecutiveFailures = 0;
const MAX_FAILURES_BEFORE_ALERT = 3;

if (!PROJECT_ID || !API_KEY) {
  console.error('缺少 FIREBASE_PROJECT_ID 或 FIREBASE_API_KEY');
  process.exit(1);
}

const OPENCLAW_BIN = '/home/openclaw/.npm-global/bin/openclaw';

/**
 * 執行 shell 指令並返回 Promise
 */
function runCommand(cmd) {
  // Replace direct 'openclaw' command with absolute path
  if (cmd.startsWith('openclaw ')) {
    cmd = cmd.replace('openclaw ', `${OPENCLAW_BIN} `);
  }
  return new Promise((resolve, reject) => {
    exec(cmd, { maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        reject(error);
      } else {
        resolve(stdout);
      }
    });
  });
}

/**
 * 解析 openclaw models 輸出獲取模型額度
 */
function parseModelsOutput(output) {
  // 去除 ANSI 顏色代碼
  output = output.replace(/\x1B\[[0-9;]*[mK]/g, '');
  
  const models = {};
  
  // Debug output
  console.log('Raw Models Output (stripped):', output);

  // 嘗試匹配多種格式
  // Format: gemini-3-pro-low 80% left ⏱3h 44m
  // 使用更通用的 regex，匹配到 % left 前的任意非空白字串
  const regex = /(\S+)\s+(\d+)%\s+left/g;
  let match;
  
  while ((match = regex.exec(output)) !== null) {
    let name = match[1];
    // 過濾雜訊：跳過非模型名稱的匹配
    if (name === 'usage' || name === 'usage:' || name === 'left' || name.length < 3) continue;
    // 跳過不含 '-' 的短詞（模型名稱通常有 provider-model 格式）
    if (!name.includes('-') && name.length < 10) continue;
    
    models[name] = parseInt(match[2], 10);
  }
  
  // 補完：解析 Configured models 行，將有配置但沒 Usage 數據的模型設為 -1
  // Format: Configured models (2): google-antigravity/claude-opus-4-5-thinking, google-antigravity/gemini-3-pro-low
  const configuredMatch = output.match(/Configured models \(\d+\):\s*(.+)/i);
  if (configuredMatch) {
    const configuredList = configuredMatch[1].split(',').map(s => s.trim());
    console.log('Configured models found:', configuredList);
    
    for (const fullModel of configuredList) {
      // 提取模型名稱 (移除 provider 前綴)
      const parts = fullModel.split('/');
      const modelName = parts.length > 1 ? parts[parts.length - 1] : fullModel;
      
      // 如果這個模型沒有 usage 數據，補上 -1
      if (!models[modelName] && modelName.length > 3) {
        console.log(`  → Adding missing model: ${modelName} = -1 (no usage data)`);
        models[modelName] = -1;
      }
    }
  }
  
  console.log('Parsed Models (with fallback):', models);
  return models;
}

const SESSIONS_PATH = '/home/openclaw/.openclaw/agents/main/sessions/sessions.json';

/**
 * V2.1: 檢查 tasks/inbox/ 目錄中的待派發任務
 * @returns {Array} 待派發的任務列表 (供 Dashboard 顯示)
 */
function processInbox(agents) {
  const tasks = [];
  
  try {
    if (!fs.existsSync(INBOX_PATH)) return tasks;
    
    const files = fs.readdirSync(INBOX_PATH);
    
    for (const file of files) {
      if (!file.endsWith('.md')) continue;
      
      const filePath = path.join(INBOX_PATH, file);
      const stat = fs.statSync(filePath);
      const content = fs.readFileSync(filePath, 'utf8');
      
      // 解析 Frontmatter
      const statusMatch = content.match(/status:\s*["']?(\w+)["']?/);
      const typeMatch = content.match(/type:\s*["']?(\w+)["']?/);
      const status = statusMatch ? statusMatch[1] : 'unknown';
      
      // 讀取標題 (第一行)
      let title = file.replace('.md', '');
      const firstLine = content.split('\n')[0];
      if (firstLine.startsWith('# ')) title = firstLine.slice(2).trim();
      else if (firstLine.startsWith('## ')) title = firstLine.slice(3).trim();
      else if (firstLine.trim()) title = firstLine.trim().substring(0, 50);

      // 如果是 Pending，嘗試分派
      if (status === 'pending') {
          const type = typeMatch ? typeMatch[1] : 'general';
          let targetLabel = 'handyman';
          let targetModel = 'google-antigravity/gemini-3-pro-high';
          
          if (type === 'coding') {
              targetLabel = 'tech_team';
              targetModel = 'google-antigravity/claude-opus-4-5-thinking';
          }
          
          // 檢查 Executor 是否 Idle (只要沒有 active session 就算 idle)
          // 注意：agents 陣列包含了所有 active session
          const isBusy = agents.some(a => a.label === targetLabel && a.status === 'active');
          
          if (!isBusy) {
              console.log(`[Router] Dispatching ${file} to ${targetLabel}...`);
              
              // 1. 更新狀態為 dispatched (避免重複派送)
              const newContent = content.replace(/status:\s*["']?pending["']?/, 'status: "dispatched"');
              fs.writeFileSync(filePath, newContent);
              
              // 2. 執行 Spawn 指令
              const taskInstruction = `你現在位於 ${WORKSPACE_PATH}。請務必使用 read 工具讀取 ${filePath}，然後執行其中的指示。成功或失敗請務必更新檔案狀態 (status: "completed" 或 "failed")，並簡短說明原因。`;
              const command = `${OPENCLAW_BIN} sessions spawn --agent main --label ${targetLabel} --model ${targetModel} --task "${taskInstruction}"`;
              
              exec(command, (err, stdout, stderr) => {
                  if (err) {
                      console.error(`[Router] Dispatch failed: ${err.message}`);
                      // 失敗回滾
                      fs.writeFileSync(filePath, content);
                  } else {
                      console.log(`[Router] Dispatched: ${stdout.trim()}`);
                  }
              });
              
              // 更新本次顯示狀態
              tasks.push({
                id: `inbox-${file}`,
                title: title,
                status: 'dispatched',
                updatedAt: Date.now()
              });
              continue; // 已處理，跳過加入 pending 列表
          } else {
              console.log(`[Router] ${targetLabel} is busy, ${file} queued.`);
          }
      }
      
      // 加入列表顯示
      tasks.push({
        id: `inbox-${file}`,
        title: title,
        status: status,
        updatedAt: Math.floor(stat.mtimeMs)
      });
    }
    
    tasks.sort((a, b) => a.updatedAt - b.updatedAt); // 舊的在前 (FIFO)
    
  } catch (err) {
    console.error('processInbox error:', err.message);
  }
  
  return tasks;
}

/**
 * V2.1: Health Check - 發送告警通知
 */
async function sendHealthAlert(message) {
  try {
    await sleep(1000);
    await runCommand(`openclaw message send --target="telegram" --message="🚨 Monitor Alert: ${message}"`);
    console.log('Health alert sent:', message);
    await sleep(1000);
  } catch (err) {
    console.error('Failed to send health alert:', err.message);
  }
}

/**
 * 從 .jsonl 檔案讀取第一行 task (或最後一行 user message)
 */
async function getTaskTitleFromLog(filePath) {
  if (!fs.existsSync(filePath)) return null;
  
  try {
    const stream = fs.createReadStream(filePath);
    const rl = readline.createInterface({
      input: stream,
      crlfDelay: Infinity
    });

    let firstUserMessage = null;
    let linesRead = 0;

    for await (const line of rl) {
      if (linesRead > 10) break; // 只讀前幾行找 task
      try {
        const entry = JSON.parse(line);
        // 尋找 task 描述 (通常在 user message)
        if (entry.type === 'user' || entry.role === 'user') {
            let text = entry.content || entry.message || '';
            // 過濾掉簡短指令
            if (text.length > 5) {
                firstUserMessage = text;
                break;
            }
        }
      } catch (e) {}
      linesRead++;
    }
    
    // stream.destroy(); // readline handles close
    
    if (firstUserMessage) {
        // 清理 Metadata (e.g. [Telegram ...])
        firstUserMessage = firstUserMessage.replace(/^\[.*?\]\s*/g, '');
        // 截斷過長文字
        return firstUserMessage.length > 50 ? firstUserMessage.substring(0, 50) + '...' : firstUserMessage;
    }
  } catch (err) {
    console.error('讀取 log 失敗:', err.message);
  }
  return null;
}

/**
 * 解析 sessions JSON 獲取 agents 狀態 (直接讀取 sessions.json)
 */
function parseSessionsFile() {
  try {
    if (!fs.existsSync(SESSIONS_PATH)) return [];
    
    const content = fs.readFileSync(SESSIONS_PATH, 'utf8');
    const data = JSON.parse(content);
    let agents = [];
    const now = Date.now();
    
    // 特勤局映射 (ID 對應)
    const labelMapping = {
      'coding_team': '程式組',
      'dev_team': '開發組',
      'handyman': '雜工'
    };
    
    Object.values(data).forEach(session => {
      // 判斷是否活躍 (5分鐘內更新)
      const ageMs = now - (session.updatedAt || 0);
      const isActive = ageMs < 300000;
      
      let label = session.label || 'Unknown';
      
      // 中文化
      if (labelMapping[label]) {
        label = labelMapping[label];
      } else if (session.sessionId === '5907ddda-6411-4999-9578-7e841f351d63' || session.key === 'agent:main:main') { // Main Session ID
        label = '羊羊';
      }
      
      agents.push({
        key: session.sessionId,
        label: label,
        model: session.model || session.modelProvider || 'unknown',
        status: isActive ? 'active' : 'idle',
        ageMs: ageMs,
        tokens: (session.totalTokens || (session.inputTokens + session.outputTokens) || 0),
        sessionId: session.sessionId,
        updatedAt: session.updatedAt,
        sessionFile: session.sessionFile
      });
    });

    // 處理重複名稱 (Adding suffix)
    const labelCounts = {};
    // 先計算每個 label 出現次數
    agents.forEach(a => {
      labelCounts[a.label] = (labelCounts[a.label] || 0) + 1;
    });

    // 再次遍歷，為重複的添加編號
    const currentCounts = {};
    agents.forEach(a => {
      if (labelCounts[a.label] > 1 && a.label !== '羊羊') { // 羊羊通常只有一個，且不想被編號
        currentCounts[a.label] = (currentCounts[a.label] || 0) + 1;
        a.label = `${a.label}-${currentCounts[a.label]}`;
      }
    });
    
    // 排序: 羊羊優先，其他按時間
    agents.sort((a, b) => {
      if (a.label === '羊羊') return -1;
      if (b.label === '羊羊') return 1;
      return a.ageMs - b.ageMs;
    });

    return agents;
  } catch (err) {
    console.error('讀取 sessions.json 失敗:', err.message);
    return [];
  }
}

/**
 * 從 session 獲取簡單任務狀態
 */
async function getTasks() {
  try {
    if (!fs.existsSync(SESSIONS_PATH)) return [];
    
    const content = fs.readFileSync(SESSIONS_PATH, 'utf8');
    const data = JSON.parse(content);
    const tasks = [];
    const now = Date.now();
    
    // 1. 先檢查 Inbox 中待派發的任務 (移至 updateStatus 統一處理)
    
    // 獲取所有 sessions 並排序
    const sessions = Object.values(data).sort((a, b) => b.updatedAt - a.updatedAt);
    
    for (const session of sessions) {
      // 隱藏超過 1 小時的已完成任務
      const isDone = session.totalTokens > 0 && (now - session.updatedAt > 120000); 
      if (isDone && (now - session.updatedAt > 3600000)) continue;
      
      const status = isDone ? 'done' : 'running';
      
      let label = session.label || 'Unknown';
      let title = label;

      // 嘗試讀取真實任務內容
      if (session.sessionFile) {
          const realTitle = await getTaskTitleFromLog(session.sessionFile);
          if (realTitle) {
              title = realTitle;
          }
      }
      
      // Fallback 翻譯
      if (title === label) {
        if (label === 'coding_team') title = '程式組任務';
        else if (label === 'dev_team') title = '開發組任務';
        else if (label === 'handyman') title = '雜工任務';
        else if (label.toLowerCase() === 'unknown') {
            title = session.sessionId.includes('subagent') ? '子任務' : '系統維護';
        }
      }
      
      if (session.key === 'agent:main:main') return; // 不顯示主進程
      
      tasks.push({
        id: session.sessionId,
        title: title,
        status: status,
        updatedAt: session.updatedAt
      });
    }
    
    // 獲取 Cron Jobs (模擬)
    // 這裡應該透過 exec('openclaw cron list') 獲取，為求效能暫時模擬每日任務
    tasks.push({
      id: 'cron-daily',
      title: '每日 22:00 優化回顧',
      status: 'scheduled',
      updatedAt: now
    });
    
    return tasks;
  } catch (err) {
    console.error('獲取任務失敗:', err.message);
    return [];
  }
}

/**
 * 使用 REST API 更新 Firestore 文件
 */
async function updateStatus() {
  const now = new Date();
  
  // 獲取模型額度
  let models = {};
  try {
    const modelsOutput = await runCommand('openclaw models 2>&1');
    models = parseModelsOutput(modelsOutput);
    console.log(`[${now.toISOString()}] 模型額度:`, JSON.stringify(models));
  } catch (err) {
    console.error(`[${now.toISOString()}] 獲取模型狀態失敗:`, err.message);
  }
  
  await sleep(1000);
  
  // 獲取 sessions (改用文件讀取)
  let agents = [];
  try {
    agents = parseSessionsFile();
  } catch (err) {
    console.error(`[${now.toISOString()}] 獲取 sessions 失敗:`, err.message);
  }

  await sleep(1000);
  
  // 獲取任務
  const tasks = await getTasks();
  
  // 執行 Router 檢查並合併 Inbox 任務 (這裡做真正的 Dispatch)
  const inboxTasks = processInbox(agents);
  
  // 合併任務列表 (Inbox 任務優先顯示)
  const allTasks = [...inboxTasks, ...tasks];

  // 構建 Firestore 格式的 agents array
  const agentsArray = agents.map(a => ({
    mapValue: {
      fields: {
        key: { stringValue: a.key },
        label: { stringValue: a.label },
        model: { stringValue: a.model },
        status: { stringValue: a.status },
        ageMs: { integerValue: a.ageMs.toString() },
        tokens: { integerValue: a.tokens.toString() }
      }
    }
  }));
  
  // 構建 Firestore 格式的 tasks array
  const tasksArray = allTasks.map(t => ({
    mapValue: {
      fields: {
        id: { stringValue: t.id },
        title: { stringValue: t.title },
        status: { stringValue: t.status },
        updatedAt: { integerValue: t.updatedAt.toString() }
      }
    }
  }));

  // 構建 Firestore 格式的 models map
  const modelsFields = {};
  Object.entries(models).forEach(([name, percent]) => {
    modelsFields[name] = { integerValue: percent.toString() };
  });

  const data = JSON.stringify({
    fields: {
      last_seen: { timestampValue: now.toISOString() },
      last_seen_local: { stringValue: now.toISOString() },
      status: { stringValue: 'online' },
      message: { stringValue: 'Dashboard V4.1.1 Active' },
      updated_at: { integerValue: Date.now().toString() },
      models: { mapValue: { fields: modelsFields } },
      agents: { arrayValue: { values: agentsArray } },
      tasks: { arrayValue: { values: tasksArray } },
      version: { stringValue: '4.1.1' }
    }
  });
  
  const docPath = `projects/${PROJECT_ID}/databases/(default)/documents/status/main`;
  const url = `https://firestore.googleapis.com/v1/${docPath}?key=${API_KEY}`;
  
  const urlObj = new URL(url);
  const options = {
    hostname: urlObj.hostname,
    path: urlObj.pathname + urlObj.search,
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(data)
    }
  };

  const req = https.request(options, (res) => {
    let body = '';
    res.on('data', chunk => body += chunk);
    res.on('end', () => {
      if (res.statusCode >= 200 && res.statusCode < 300) {
        console.log(`[${now.toISOString()}] ✓ Heartbeat V4.1.1 sent`);
        consecutiveFailures = 0;
      } else {
        console.error(`[${now.toISOString()}] ✗ Error ${res.statusCode}:`, body);
        consecutiveFailures++;
      }
    });
  });

  req.on('error', (err) => {
    console.error(`[${now.toISOString()}] ✗ Request failed:`, err.message);
    consecutiveFailures++;
  });

  req.write(data);
  req.end();
  
  // Health Check
  if (consecutiveFailures >= MAX_FAILURES_BEFORE_ALERT) {
      sendHealthAlert(`Monitor failed to update Firestore for ${consecutiveFailures} times.`);
      consecutiveFailures = 0; // Reset to avoid spam
  }
}

// 啟動
console.log('=== OpenClaw Monitor V4.1.1 ===');
console.log(`Project: ${PROJECT_ID}`);
console.log(`Interval: ${INTERVAL_MS / 1000}s`);
console.log('-----------------------------');

// 立即執行一次
updateStatus();

// 設定定時執行
setInterval(updateStatus, INTERVAL_MS);

// 優雅退出
process.on('SIGINT', () => {
  console.log('\n👋 Monitor V4.1.1 stopped');
  process.exit(0);
});
