#!/usr/bin/env node
/**
 * Dashboard Health Check Script
 * 每日檢查 Dashboard 狀態，異常時發送 Telegram 通知
 */

const https = require('https');
const http = require('http');

const CONFIG = {
  dashboardUrl: process.env.DASHBOARD_URL || 'http://localhost:3000',
  telegramBotToken: process.env.TELEGRAM_BOT_TOKEN,
  telegramChatId: process.env.TELEGRAM_CHAT_ID,
  timeout: 10000, // 10 seconds
  retries: 3,
  retryDelay: 5000 // 5 seconds
};

async function checkHealth(url, attempt = 1) {
  return new Promise((resolve) => {
    const client = url.startsWith('https') ? https : http;
    
    const req = client.get(url, { timeout: CONFIG.timeout }, (res) => {
      resolve({
        success: res.statusCode === 200,
        statusCode: res.statusCode,
        message: `HTTP ${res.statusCode}`
      });
    });

    req.on('error', (err) => {
      resolve({
        success: false,
        statusCode: null,
        message: err.message
      });
    });

    req.on('timeout', () => {
      req.destroy();
      resolve({
        success: false,
        statusCode: null,
        message: 'Request timeout'
      });
    });
  });
}

async function sendTelegramAlert(message) {
  if (!CONFIG.telegramBotToken || !CONFIG.telegramChatId) {
    console.log('[Alert] Telegram not configured, logging only:', message);
    return;
  }

  const url = `https://api.telegram.org/bot${CONFIG.telegramBotToken}/sendMessage`;
  const data = JSON.stringify({
    chat_id: CONFIG.telegramChatId,
    text: `🚨 Dashboard Health Alert\n\n${message}`,
    parse_mode: 'HTML'
  });

  return new Promise((resolve) => {
    const req = https.request(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data)
      }
    }, (res) => {
      resolve(res.statusCode === 200);
    });

    req.on('error', () => resolve(false));
    req.write(data);
    req.end();
  });
}

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function runHealthCheck() {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] Starting health check for: ${CONFIG.dashboardUrl}`);

  let lastResult = null;
  
  for (let attempt = 1; attempt <= CONFIG.retries; attempt++) {
    lastResult = await checkHealth(CONFIG.dashboardUrl, attempt);
    
    if (lastResult.success) {
      console.log(`[✓] Dashboard is healthy (${lastResult.message})`);
      return { healthy: true, attempts: attempt };
    }
    
    console.log(`[!] Attempt ${attempt}/${CONFIG.retries} failed: ${lastResult.message}`);
    
    if (attempt < CONFIG.retries) {
      await sleep(CONFIG.retryDelay);
    }
  }

  // All retries failed - send alert
  const alertMessage = [
    `<b>時間:</b> ${timestamp}`,
    `<b>URL:</b> ${CONFIG.dashboardUrl}`,
    `<b>狀態:</b> ${lastResult.message}`,
    `<b>重試次數:</b> ${CONFIG.retries}`,
    '',
    '請檢查 Dashboard 服務狀態！'
  ].join('\n');

  await sendTelegramAlert(alertMessage);
  console.log(`[✗] Dashboard is DOWN after ${CONFIG.retries} attempts`);
  
  return { healthy: false, attempts: CONFIG.retries, error: lastResult.message };
}

// Run if executed directly
if (require.main === module) {
  runHealthCheck()
    .then(result => {
      process.exit(result.healthy ? 0 : 1);
    })
    .catch(err => {
      console.error('Health check error:', err);
      process.exit(1);
    });
}

module.exports = { runHealthCheck, checkHealth, sendTelegramAlert };
