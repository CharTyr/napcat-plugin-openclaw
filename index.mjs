// NapCat Plugin Entry Point
// ⚠️ Legacy file: this file is kept for compatibility; index.js is the canonical source of truth.

// ========== OpenClaw WebSocket Client ==========
import WebSocket from 'ws';

class OpenClawClient {
  constructor(host, port, token, logInfo, logError) {
    this.host = host;
    this.port = port;
    this.token = token;
    this.logInfo = logInfo;
    this.logError = logError;
  }

  async executeTask(taskText, sessionKey, timeoutSec) {
    return new Promise((resolve) => {
      const wsUrl = `ws://${this.host}:${this.port}`;
      const ws = new WebSocket(wsUrl);
      
      let result = '';
      let isEnded = false;
      let needInput = false;

      const timeout = setTimeout(() => {
        if (!isEnded) {
          isEnded = true;
          ws.close();
          resolve({ ok: false, result: '', needInput: false, error: '任务执行超时' });
        }
      }, timeoutSec * 1000);

      ws.on('open', () => {
        this.logInfo(`[OpenClaw] Connected for session: ${sessionKey}`);
        
        // 发送认证
        ws.send(JSON.stringify({
          type: 'auth',
          token: this.token
        }));

        // 发送 agent 消息
        ws.send(JSON.stringify({
          type: 'agent',
          sessionKey: sessionKey,
          message: taskText
        }));
      });

      ws.on('message', (data) => {
        try {
          const msg = JSON.parse(data.toString());
          
          switch (msg.type) {
            case 'auth_success':
              this.logInfo('[OpenClaw] Auth success');
              break;
              
            case 'auth_error':
              isEnded = true;
              clearTimeout(timeout);
              ws.close();
              resolve({ ok: false, result: '', needInput: false, error: '认证失败' });
              break;
              
            case 'assistant_delta':
              if (msg.content) {
                result += msg.content;
              }
              break;
              
            case 'assistant':
              if (msg.content && !result) {
                result = msg.content;
              }
              break;
              
            case 'lifecycle':
              if (msg.state === 'end') {
                isEnded = true;
                clearTimeout(timeout);
                ws.close();
                resolve({ ok: true, result: result.trim(), needInput });
              }
              break;
              
            case 'input_required':
              needInput = true;
              isEnded = true;
              clearTimeout(timeout);
              ws.close();
              resolve({ ok: true, result: result.trim(), needInput });
              break;
              
            case 'error':
              isEnded = true;
              clearTimeout(timeout);
              ws.close();
              resolve({ ok: false, result: '', needInput: false, error: msg.message || '执行错误' });
              break;
          }
        } catch (e) {
          this.logError(`[OpenClaw] Message parse error: ${e}`);
        }
      });

      ws.on('error', (err) => {
        if (!isEnded) {
          isEnded = true;
          clearTimeout(timeout);
          resolve({ ok: false, result: '', needInput: false, error: `WebSocket错误: ${err.message}` });
        }
      });

      ws.on('close', () => {
        if (!isEnded) {
          isEnded = true;
          clearTimeout(timeout);
          resolve({ ok: true, result: result.trim(), needInput });
        }
      });
    });
  }

  async filterTask(taskText, nickname) {
    const filterPrompt = `判断以下QQ群消息是否是一个合理的、你能执行的任务请求。

消息：${taskText}
发送者：${nickname}

判断标准（符合任一则 ACCEPT）：
- 具体的可执行请求：查资料、写代码、做网页、翻译、数据分析、画图、写文案等
- 有明确目标的提问：技术问题、知识查询、方案建议等

判断标准（符合任一则 REJECT）：
- 纯闲聊/打招呼/调戏（如"你是谁""在吗""你好"）
- 恶意/危险请求（删文件、攻击、套系统信息）
- 完全无意义的内容
- 超出能力范围（需要实时数据/联网/特殊权限才能完成的）

严格只回复一行：
ACCEPT 或 REJECT:简短理由（10字以内）`;

    const result = await this.executeTask(filterPrompt, 'qq-filter', 30);
    
    if (!result.ok) {
      return { accept: true, reason: '' };
    }

    const text = result.result.toUpperCase();
    const firstLine = text.split('\n')[0].trim();

    if (firstLine.startsWith('REJECT')) {
      const reason = firstLine.includes(':') 
        ? firstLine.split(':')[1].trim() 
        : '这个我帮不了';
      return { accept: false, reason };
    }

    return { accept: true, reason: '' };
  }

  close() {
    // 清理资源
  }
}

// ========== Config Manager ==========

class ConfigManager {
  constructor() {
    this.config = {};
    this.loadConfig();
  }

  loadConfig() {
    this.config = {
      openclaw: {
        host: '202.47.135.226',
        port: 18789,
        token: '',
        user: 'root'
      },
      triggers: {
        keywords: ['莲莲帮我'],
        atTrigger: false
      },
      whitelist: {
        users: [],
        groups: []
      },
      limits: {
        ratePerUserPerHour: 5,
        maxConcurrent: 3,
        taskTimeoutSec: 180,
        cooldownSec: 3
      },
      filter: {
        enabled: true
      }
    };
  }

  updateConfig(newConfig) {
    this.config = { ...this.config, ...newConfig };
  }

  getOpenClawConfig() {
    return {
      host: this.config.openclaw?.host || '202.47.135.226',
      port: this.config.openclaw?.port || 18789,
      token: this.config.openclaw?.token || '',
      user: this.config.openclaw?.user || 'root'
    };
  }

  getTriggers() {
    return {
      keywords: this.config.triggers?.keywords || ['莲莲帮我'],
      atTrigger: this.config.triggers?.atTrigger || false,
      botUserId: this.config.botUserId
    };
  }

  getWhitelist() {
    return {
      users: this.config.whitelist?.users || [],
      groups: this.config.whitelist?.groups || []
    };
  }

  getLimits() {
    return {
      ratePerUserPerHour: this.config.limits?.ratePerUserPerHour || 5,
      maxConcurrent: this.config.limits?.maxConcurrent || 3,
      taskTimeoutSec: this.config.limits?.taskTimeoutSec || 180,
      cooldownSec: this.config.limits?.cooldownSec || 3
    };
  }

  getCooldown() {
    return this.config.limits?.cooldownSec || 3;
  }

  getTaskTimeout() {
    return this.config.limits?.taskTimeoutSec || 180;
  }

  isFilterEnabled() {
    return this.config.filter?.enabled !== false;
  }

  isGroupAllowed(groupId) {
    const groups = this.getWhitelist().groups;
    if (groups.length === 0) return true;
    return groups.includes(groupId);
  }

  isUserAllowed(userId) {
    const users = this.getWhitelist().users;
    if (users.length === 0) return true;
    return users.includes(userId);
  }

  setBotUserId(botUserId) {
    this.config.botUserId = botUserId;
  }
}

// ========== Task Manager ==========

const TaskState = {
  PENDING: 'pending',
  RUNNING: 'running',
  WAITING_INPUT: 'waiting_input',
  DONE: 'done',
  TIMEOUT: 'timeout',
  FAILED: 'failed'
};

class TaskManager {
  constructor(limits) {
    this.tasks = new Map();
    this.activeTasks = new Map();
    this.userRequestLog = new Map();
    this.limits = limits;
  }

  userKey(groupId, userId) {
    return `${groupId}:${userId}`;
  }

  generateTaskId() {
    return Math.random().toString(36).substring(2, 10);
  }

  checkRateLimit(userId) {
    const key = String(userId);
    const now = Date.now();
    const hourAgo = now - 3600000;
    
    const logs = this.userRequestLog.get(key) || [];
    const recent = logs.filter(t => t > hourAgo);
    this.userRequestLog.set(key, recent);
    
    return recent.length < this.limits.ratePerUserPerHour;
  }

  countRunning() {
    let count = 0;
    for (const task of this.tasks.values()) {
      if (task.state === TaskState.RUNNING || task.state === TaskState.WAITING_INPUT) {
        count++;
      }
    }
    return count;
  }

  createTask(groupId, userId, userNickname, text, messageId, sessionKey) {
    if (!this.checkRateLimit(userId)) {
      return { ok: false, error: '请求太频繁了，歇一会儿再来～' };
    }

    if (this.countRunning() >= this.limits.maxConcurrent) {
      return { ok: false, error: '当前任务太多了，稍等一下～' };
    }

    const task = {
      taskId: this.generateTaskId(),
      groupId,
      userId,
      userNickname,
      text,
      messageId,
      sessionKey,
      state: TaskState.PENDING,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      result: '',
      error: ''
    };

    this.tasks.set(task.taskId, task);
    this.activeTasks.set(this.userKey(groupId, userId), task);

    const logs = this.userRequestLog.get(String(userId)) || [];
    logs.push(Date.now());
    this.userRequestLog.set(String(userId), logs);

    return { ok: true, task };
  }

  getWaitingTask(groupId, userId) {
    const key = this.userKey(groupId, userId);
    const task = this.activeTasks.get(key);
    
    if (!task || task.state !== TaskState.WAITING_INPUT) {
      return null;
    }

    const timeout = this.limits.taskTimeoutSec * 1000;
    if (Date.now() - task.updatedAt > timeout) {
      this.timeoutTask(task.taskId);
      return null;
    }

    return task;
  }

  setRunning(taskId) {
    const task = this.tasks.get(taskId);
    if (task) {
      task.state = TaskState.RUNNING;
      task.updatedAt = Date.now();
    }
  }

  setWaitingInput(taskId) {
    const task = this.tasks.get(taskId);
    if (task) {
      task.state = TaskState.WAITING_INPUT;
      task.updatedAt = Date.now();
    }
  }

  completeTask(taskId, result) {
    const task = this.tasks.get(taskId);
    if (task) {
      task.state = TaskState.DONE;
      task.result = result;
      task.updatedAt = Date.now();
      this.activeTasks.delete(this.userKey(task.groupId, task.userId));
    }
  }

  failTask(taskId, error) {
    const task = this.tasks.get(taskId);
    if (task) {
      task.state = TaskState.FAILED;
      task.error = error;
      task.updatedAt = Date.now();
      this.activeTasks.delete(this.userKey(task.groupId, task.userId));
    }
  }

  timeoutTask(taskId) {
    const task = this.tasks.get(taskId);
    if (task) {
      task.state = TaskState.TIMEOUT;
      task.updatedAt = Date.now();
      this.activeTasks.delete(this.userKey(task.groupId, task.userId));
    }
  }

  cleanupOldTasks(maxAgeMs = 3600000) {
    const now = Date.now();
    for (const [taskId, task] of this.tasks) {
      if (
        (task.state === TaskState.DONE || 
         task.state === TaskState.FAILED || 
         task.state === TaskState.TIMEOUT) &&
        now - task.updatedAt > maxAgeMs
      ) {
        this.tasks.delete(taskId);
      }
    }
  }

  getStats() {
    const stats = {};
    for (const task of this.tasks.values()) {
      stats[task.state] = (stats[task.state] || 0) + 1;
    }
    return stats;
  }
}

// ========== File Fetcher ==========

import { execFile } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import * as path from 'path';

const execFileAsync = promisify(execFile);

const MARKER_FILE = '/tmp/.seren_task_marker';
const LOCAL_FILE_DIR = '/tmp/napcat-openclaw-files';
const REMOTE_OUTPUT_DIR = '/root/.openclaw/workspace/output';

class FileFetcher {
  constructor(host, user = 'root') {
    this.host = host;
    this.user = user;
    
    if (!fs.existsSync(LOCAL_FILE_DIR)) {
      fs.mkdirSync(LOCAL_FILE_DIR, { recursive: true });
    }
  }

  getHostTarget() {
    if (!/^[a-zA-Z0-9._-]+$/.test(this.user) || !/^[a-zA-Z0-9._:-]+$/.test(this.host)) {
      throw new Error('invalid ssh target');
    }
    return `${this.user}@${this.host}`;
  }

  validateRemotePath(remotePath) {
    const normalized = String(remotePath || '').trim();
    if (!normalized.startsWith(`${REMOTE_OUTPUT_DIR}/`)) {
      throw new Error(`remote path out of allowed dir: ${normalized}`);
    }
    if (/[\r\n\0]/.test(normalized)) {
      throw new Error('remote path contains invalid characters');
    }
    return normalized;
  }

  async createMarker() {
    try {
      await execFileAsync('ssh', [
        '-o', 'ConnectTimeout=5',
        '-o', 'StrictHostKeyChecking=no',
        this.getHostTarget(),
        'touch',
        MARKER_FILE
      ]);
    } catch (e) {
      // 静默失败
    }
  }

  async fetchNewFiles() {
    const localFiles = [];

    try {
      const { stdout } = await execFileAsync('ssh', [
        '-o', 'ConnectTimeout=10',
        '-o', 'StrictHostKeyChecking=no',
        this.getHostTarget(),
        'find',
        REMOTE_OUTPUT_DIR,
        '-type',
        'f',
        '-newer',
        MARKER_FILE
      ], { timeout: 30000 });
      const remoteFiles = stdout.trim().split('\n').filter(f => f.length > 0);

      if (remoteFiles.length === 0) {
        return [];
      }

      const taskDir = path.join(LOCAL_FILE_DIR, Date.now().toString());
      if (!fs.existsSync(taskDir)) {
        fs.mkdirSync(taskDir, { recursive: true });
      }

      for (const remotePath of remoteFiles) {
        const safeRemotePath = this.validateRemotePath(remotePath);
        const fileName = path.basename(safeRemotePath);
        const localPath = path.join(taskDir, fileName);

        try {
          await execFileAsync('scp', [
            '-o', 'ConnectTimeout=10',
            '-o', 'StrictHostKeyChecking=no',
            `${this.getHostTarget()}:${safeRemotePath}`,
            localPath
          ], { timeout: 60000 });

          if (fs.existsSync(localPath)) {
            localFiles.push(localPath);
          }
        } catch (e) {
          // 单个文件失败继续尝试其他文件
        }
      }

      return localFiles;
    } catch (e) {
      return [];
    }
  }

  cleanupOldFiles(maxAgeHours = 24) {
    try {
      const now = Date.now();
      const maxAgeMs = maxAgeHours * 3600000;

      const entries = fs.readdirSync(LOCAL_FILE_DIR);
      for (const entry of entries) {
        const entryPath = path.join(LOCAL_FILE_DIR, entry);
        const stats = fs.statSync(entryPath);
        
        if (now - stats.mtime.getTime() > maxAgeMs) {
          if (stats.isDirectory()) {
            fs.rmSync(entryPath, { recursive: true });
          } else {
            fs.unlinkSync(entryPath);
          }
        }
      }
    } catch (e) {
      // 清理失败不影响主流程
    }
  }
}

// ========== Plugin Entry Point ==========

let ctx = null;
let configManager = null;
let taskManager = null;
let openClawClient = null;
let fileFetcher = null;
let lastSendTime = 0;

export async function plugin_init(context) {
  ctx = context;
  ctx.log.info('[OpenClaw] Plugin initializing...');

  configManager = new ConfigManager();
  taskManager = new TaskManager(configManager.getLimits());
  
  const openClawConfig = configManager.getOpenClawConfig();
  openClawClient = new OpenClawClient(
    openClawConfig.host,
    openClawConfig.port,
    openClawConfig.token,
    (msg) => ctx?.log.info(msg),
    (msg) => ctx?.log.error(msg)
  );

  fileFetcher = new FileFetcher(openClawConfig.host, openClawConfig.user || 'root');

  ctx.log.info('[OpenClaw] Plugin initialized successfully');
}

export async function plugin_onmessage(event) {
  if (!ctx || !configManager || !taskManager || !openClawClient || !fileFetcher) {
    return;
  }

  if (event.post_type !== 'message' || event.message_type !== 'group') {
    return;
  }

  const groupId = event.group_id;
  const userId = event.user_id;
  const messageId = event.message_id;
  const nickname = event.sender?.nickname || '未知';

  if (!groupId) return;

  if (!configManager.isGroupAllowed(groupId)) return;
  if (!configManager.isUserAllowed(userId)) return;

  const text = extractText(event.message);
  if (!text) return;

  const waitingTask = taskManager.getWaitingTask(groupId, userId);
  if (waitingTask) {
    await continueTask(waitingTask, text, groupId, messageId);
    return;
  }

  const triggerResult = checkTrigger(text, event.message, configManager.getTriggers());
  if (!triggerResult.triggered) return;

  ctx.log.info(`[OpenClaw] Triggered by ${nickname}(${userId}): ${triggerResult.taskText.slice(0, 50)}`);

  const sessionKey = `qq-${groupId}-${userId}`;
  const createResult = taskManager.createTask(groupId, userId, nickname, triggerResult.taskText, messageId, sessionKey);
  
  if (!createResult.ok) {
    await sendReply(groupId, messageId, createResult.error || '创建任务失败');
    return;
  }

  const task = createResult.task;

  if (configManager.isFilterEnabled()) {
    const filterResult = await openClawClient.filterTask(triggerResult.taskText, nickname);
    if (!filterResult.accept) {
      taskManager.failTask(task.taskId, 'filtered');
      await sendReply(groupId, messageId, filterResult.reason || '这个请求我帮不了呢~');
      return;
    }
  }

  await runTask(task, groupId, messageId);
}

export async function plugin_cleanup() {
  ctx?.log.info('[OpenClaw] Plugin cleaning up...');
  openClawClient?.close();
  ctx?.log.info('[OpenClaw] Plugin cleaned up');
}

export const plugin_config_ui = {
  openclaw: {
    type: 'object',
    description: 'OpenClaw 连接配置',
    properties: {
      host: { type: 'string', default: '202.47.135.226', description: 'OpenClaw 主机地址' },
      port: { type: 'number', default: 18789, description: 'OpenClaw 端口' },
      token: { type: 'string', default: '', description: 'OpenClaw 认证 Token' },
      user: { type: 'string', default: 'root', description: 'SSH 用户名（用于 SCP 文件传输）' }
    }
  },
  triggers: {
    type: 'object',
    description: '触发词配置',
    properties: {
      keywords: { 
        type: 'array', 
        items: { type: 'string' },
        default: ['莲莲帮我'],
        description: '触发关键词列表'
      },
      atTrigger: { type: 'boolean', default: false, description: '是否支持 @ 触发' }
    }
  },
  whitelist: {
    type: 'object',
    description: '白名单配置（空数组表示允许所有）',
    properties: {
      users: { type: 'array', items: { type: 'number' }, default: [], description: '允许的用户 QQ 号' },
      groups: { type: 'array', items: { type: 'number' }, default: [], description: '允许的群号' }
    }
  },
  limits: {
    type: 'object',
    description: '限流配置',
    properties: {
      ratePerUserPerHour: { type: 'number', default: 5, description: '每小时每用户请求限制' },
      maxConcurrent: { type: 'number', default: 3, description: '最大并发任务数' },
      taskTimeoutSec: { type: 'number', default: 180, description: '任务超时时间（秒）' },
      cooldownSec: { type: 'number', default: 3, description: '发送消息冷却时间（秒）' }
    }
  },
  filter: {
    type: 'object',
    description: '意图过滤配置',
    properties: {
      enabled: { type: 'boolean', default: true, description: '是否启用意图过滤' }
    }
  }
};

// ========== Helper Functions ==========

function extractText(message) {
  const parts = [];
  for (const seg of message) {
    if (seg.type === 'text') {
      parts.push(seg.data?.text || '');
    }
  }
  return parts.join('').trim();
}

function isAtBot(message, botUserId) {
  for (const seg of message) {
    if (seg.type === 'at') {
      const qq = seg.data?.qq;
      if (String(qq) === String(botUserId)) {
        return true;
      }
    }
  }
  return false;
}

function checkTrigger(text, message, triggers) {
  for (const kw of triggers.keywords) {
    if (text.startsWith(kw)) {
      const taskText = text.slice(kw.length).trim();
      return { triggered: true, taskText: taskText || text };
    }
  }

  if (triggers.atTrigger && triggers.botUserId && isAtBot(message, triggers.botUserId)) {
    return { triggered: true, taskText: text.trim() };
  }

  return { triggered: false, taskText: '' };
}

async function sendText(groupId, text) {
  if (!ctx) return;
  await cooldown();
  
  const maxLen = 3000;
  if (text.length <= maxLen) {
    await ctx.actions.call('send_group_msg', { group_id: groupId, message: text });
  } else {
    const parts = [];
    for (let i = 0; i < text.length; i += maxLen) {
      parts.push(text.slice(i, i + maxLen));
    }
    for (let i = 0; i < parts.length; i++) {
      const prefix = parts.length > 1 ? `[${i + 1}/${parts.length}]\n` : '';
      await ctx.actions.call('send_group_msg', { group_id: groupId, message: prefix + parts[i] });
      if (i < parts.length - 1) await cooldown();
    }
  }
}

async function sendReply(groupId, messageId, text) {
  if (!ctx) return;
  await cooldown();
  await ctx.actions.call('send_group_msg', {
    group_id: groupId,
    message: [
      { type: 'reply', data: { id: String(messageId) } },
      { type: 'text', data: { text } }
    ]
  });
}

async function sendFile(groupId, filePath, fileName) {
  if (!ctx) return;
  await cooldown();
  await ctx.actions.call('upload_group_file', {
    group_id: groupId,
    file: `file://${filePath}`,
    name: fileName
  });
}

async function cooldown() {
  const cooldownSec = configManager?.getCooldown() || 3;
  const elapsed = Date.now() - lastSendTime;
  const waitMs = cooldownSec * 1000 - elapsed;
  if (waitMs > 0) {
    await new Promise(r => setTimeout(r, waitMs));
  }
  lastSendTime = Date.now();
}

async function runTask(task, groupId, messageId) {
  if (!taskManager || !openClawClient || !fileFetcher) return;

  taskManager.setRunning(task.taskId);
  await sendReply(groupId, messageId, '收到，处理中...');

  await fileFetcher.createMarker();

  const result = await openClawClient.executeTask(
    task.text,
    task.sessionKey,
    configManager?.getTaskTimeout() || 180
  );

  if (!result.ok) {
    taskManager.failTask(task.taskId, result.error || '未知错误');
    await sendText(groupId, `任务处理失败: ${result.error || '未知错误'}`);
    return;
  }

  if (result.needInput) {
    taskManager.setWaitingInput(task.taskId);
    await sendText(groupId, result.result || '等待输入...');
    return;
  }

  taskManager.completeTask(task.taskId, result.result || '');

  await sendText(groupId, result.result || '完成');

  try {
    const newFiles = await fileFetcher.fetchNewFiles();
    if (newFiles.length > 0) {
      for (const filePath of newFiles) {
        const fileName = filePath.split('/').pop() || 'file';
        await sendFile(groupId, filePath, fileName);
      }
    }
  } catch (e) {
    ctx?.log.error(`[OpenClaw] File fetch error: ${e}`);
  }
}

async function continueTask(task, inputText, groupId, messageId) {
  if (!taskManager || !openClawClient || !fileFetcher) return;

  taskManager.setRunning(task.taskId);

  const result = await openClawClient.executeTask(
    inputText,
    task.sessionKey,
    configManager?.getTaskTimeout() || 180
  );

  if (!result.ok) {
    taskManager.failTask(task.taskId, result.error || '未知错误');
    await sendText(groupId, `处理失败: ${result.error || '未知错误'}`);
    return;
  }

  if (result.needInput) {
    taskManager.setWaitingInput(task.taskId);
    await sendText(groupId, result.result || '等待输入...');
    return;
  }

  taskManager.completeTask(task.taskId, result.result || '');
  await sendText(groupId, result.result || '完成');

  try {
    const newFiles = await fileFetcher.fetchNewFiles();
    if (newFiles.length > 0) {
      for (const filePath of newFiles) {
        const fileName = filePath.split('/').pop() || 'file';
        await sendFile(groupId, filePath, fileName);
      }
    }
  } catch (e) {
    ctx?.log.error(`[OpenClaw] File fetch error: ${e}`);
  }
}
