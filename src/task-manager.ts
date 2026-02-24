// 任务管理器 - 管理任务状态、限流、并发控制
import { randomUUID } from 'crypto';

export enum TaskState {
  PENDING = 'pending',
  RUNNING = 'running',
  WAITING_INPUT = 'waiting_input',
  DONE = 'done',
  TIMEOUT = 'timeout',
  FAILED = 'failed'
}

export interface Task {
  taskId: string;
  groupId: number;
  userId: number;
  userNickname: string;
  text: string;
  messageId: number;
  sessionKey: string;
  state: TaskState;
  createdAt: number;
  updatedAt: number;
  result: string;
  error: string;
}

interface LimitsConfig {
  ratePerUserPerHour: number;
  maxConcurrent: number;
  taskTimeoutSec: number;
  cooldownSec: number;
}

interface CreateTaskResult {
  ok: boolean;
  task?: Task;
  error?: string;
}

export class TaskManager {
  private tasks: Map<string, Task> = new Map();
  private activeTasks: Map<string, Task> = new Map(); // key: "groupId:userId"
  private userRequestLog: Map<string, number[]> = new Map(); // userId -> timestamps
  private limits: LimitsConfig;

  constructor(limits: LimitsConfig) {
    this.limits = limits;
  }

  private userKey(groupId: number, userId: number): string {
    return `${groupId}:${userId}`;
  }

  private generateTaskId(): string {
    return randomUUID().replace(/-/g, '').slice(0, 8);
  }

  private checkRateLimit(userId: number): boolean {
    const key = String(userId);
    const now = Date.now();
    const hourAgo = now - 3600000;
    
    const logs = this.userRequestLog.get(key) || [];
    const recent = logs.filter(t => t > hourAgo);
    this.userRequestLog.set(key, recent);
    
    return recent.length < this.limits.ratePerUserPerHour;
  }

  private countRunning(): number {
    let count = 0;
    for (const task of this.tasks.values()) {
      if (task.state === TaskState.RUNNING || task.state === TaskState.WAITING_INPUT) {
        count++;
      }
    }
    return count;
  }

  createTask(
    groupId: number,
    userId: number,
    userNickname: string,
    text: string,
    messageId: number,
    sessionKey: string
  ): CreateTaskResult {
    // 检查限流
    if (!this.checkRateLimit(userId)) {
      return { ok: false, error: '请求太频繁了，歇一会儿再来～' };
    }

    // 检查并发
    if (this.countRunning() >= this.limits.maxConcurrent) {
      return { ok: false, error: '当前任务太多了，稍等一下～' };
    }

    const task: Task = {
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

    // 记录请求
    const logs = this.userRequestLog.get(String(userId)) || [];
    logs.push(Date.now());
    this.userRequestLog.set(String(userId), logs);

    return { ok: true, task };
  }

  getWaitingTask(groupId: number, userId: number): Task | null {
    const key = this.userKey(groupId, userId);
    const task = this.activeTasks.get(key);
    
    if (!task || task.state !== TaskState.WAITING_INPUT) {
      return null;
    }

    // 检查超时
    const timeout = this.limits.taskTimeoutSec * 1000;
    if (Date.now() - task.updatedAt > timeout) {
      this.timeoutTask(task.taskId);
      return null;
    }

    return task;
  }

  setRunning(taskId: string): void {
    const task = this.tasks.get(taskId);
    if (task) {
      task.state = TaskState.RUNNING;
      task.updatedAt = Date.now();
    }
  }

  setWaitingInput(taskId: string): void {
    const task = this.tasks.get(taskId);
    if (task) {
      task.state = TaskState.WAITING_INPUT;
      task.updatedAt = Date.now();
    }
  }

  completeTask(taskId: string, result: string): void {
    const task = this.tasks.get(taskId);
    if (task) {
      task.state = TaskState.DONE;
      task.result = result;
      task.updatedAt = Date.now();
      this.activeTasks.delete(this.userKey(task.groupId, task.userId));
    }
  }

  failTask(taskId: string, error: string): void {
    const task = this.tasks.get(taskId);
    if (task) {
      task.state = TaskState.FAILED;
      task.error = error;
      task.updatedAt = Date.now();
      this.activeTasks.delete(this.userKey(task.groupId, task.userId));
    }
  }

  timeoutTask(taskId: string): void {
    const task = this.tasks.get(taskId);
    if (task) {
      task.state = TaskState.TIMEOUT;
      task.updatedAt = Date.now();
      this.activeTasks.delete(this.userKey(task.groupId, task.userId));
    }
  }

  cleanupOldTasks(maxAgeMs: number = 3600000): void {
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

  getStats(): Record<string, number> {
    const stats: Record<string, number> = {};
    for (const task of this.tasks.values()) {
      const state = task.state;
      stats[state] = (stats[state] || 0) + 1;
    }
    return stats;
  }
}
