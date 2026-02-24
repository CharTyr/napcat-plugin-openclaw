// 文件获取器 - 通过 SSH/SCP 从 playground 获取文件

import { execFile } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import * as path from 'path';

const execFileAsync = promisify(execFile);

const MARKER_FILE = '/tmp/.seren_task_marker';
const LOCAL_FILE_DIR = '/tmp/napcat-openclaw-files';
const REMOTE_OUTPUT_DIR = '/root/.openclaw/workspace/output';

export class FileFetcher {
  private host: string;
  private user: string;
  private logger?: { warn?: (message: string) => void };

  constructor(host: string, user: string = 'root', logger?: { warn?: (message: string) => void }) {
    this.host = host;
    this.user = user;
    this.logger = logger;
    
    // 确保本地目录存在
    if (!fs.existsSync(LOCAL_FILE_DIR)) {
      fs.mkdirSync(LOCAL_FILE_DIR, { recursive: true });
    }
  }

  private getHostTarget(): string {
    if (!/^[a-zA-Z0-9._-]+$/.test(this.user) || !/^[a-zA-Z0-9._:-]+$/.test(this.host)) {
      throw new Error('invalid ssh target');
    }
    return `${this.user}@${this.host}`;
  }

  private validateRemotePath(remotePath: string): string {
    const normalized = remotePath.trim();
    if (!normalized.startsWith(`${REMOTE_OUTPUT_DIR}/`)) {
      throw new Error(`remote path out of allowed dir: ${normalized}`);
    }
    if (/[\r\n\0]/.test(normalized)) {
      throw new Error('remote path contains invalid characters');
    }
    return normalized;
  }

  // 创建标记文件（在远程执行前调用）
  async createMarker(): Promise<void> {
    try {
      await execFileAsync('ssh', [
        '-o', 'ConnectTimeout=5',
        '-o', 'StrictHostKeyChecking=no',
        this.getHostTarget(),
        'touch',
        MARKER_FILE,
      ]);
    } catch (e: any) {
      this.logger?.warn?.(`[OpenClaw] createMarker 失败: ${e?.message || e}`);
    }
  }

  // 获取新文件（在远程执行后调用）
  async fetchNewFiles(): Promise<string[]> {
    const localFiles: string[] = [];

    try {
      // 1. 在远程查找新文件
      const { stdout } = await execFileAsync(
        'ssh',
        [
          '-o', 'ConnectTimeout=10',
          '-o', 'StrictHostKeyChecking=no',
          this.getHostTarget(),
          'find',
          REMOTE_OUTPUT_DIR,
          '-type',
          'f',
          '-newer',
          MARKER_FILE,
        ],
        { timeout: 30000 }
      );
      const remoteFiles = stdout.trim().split('\n').filter(f => f.length > 0);

      if (remoteFiles.length === 0) {
        return [];
      }

      // 2. SCP 文件回本机
      const taskDir = path.join(LOCAL_FILE_DIR, Date.now().toString());
      if (!fs.existsSync(taskDir)) {
        fs.mkdirSync(taskDir, { recursive: true });
      }

      for (const remotePath of remoteFiles) {
        const safeRemotePath = this.validateRemotePath(remotePath);
        const fileName = path.basename(safeRemotePath);
        const localPath = path.join(taskDir, fileName);

        try {
          await execFileAsync(
            'scp',
            [
              '-o', 'ConnectTimeout=10',
              '-o', 'StrictHostKeyChecking=no',
              `${this.getHostTarget()}:${safeRemotePath}`,
              localPath,
            ],
            { timeout: 60000 }
          );

          if (fs.existsSync(localPath)) {
            localFiles.push(localPath);
          }
        } catch (e: any) {
          this.logger?.warn?.(`[OpenClaw] SCP 拉取失败: ${safeRemotePath} - ${e?.message || e}`);
        }
      }

      return localFiles;
    } catch (e: any) {
      // 出错时返回空数组
      this.logger?.warn?.(`[OpenClaw] fetchNewFiles 失败: ${e?.message || e}`);
      return [];
    }
  }

  // 清理旧文件（可选的定期任务）
  cleanupOldFiles(maxAgeHours: number = 24): void {
    try {
      const now = Date.now();
      const maxAgeMs = maxAgeHours * 3600000;

      const entries = fs.readdirSync(LOCAL_FILE_DIR);
      for (const entry of entries) {
        const entryPath = path.join(LOCAL_FILE_DIR, entry);
        const stats = fs.statSync(entryPath);
        
        if (now - stats.mtime.getTime() > maxAgeMs) {
          // 删除旧文件或目录
          if (stats.isDirectory()) {
            fs.rmSync(entryPath, { recursive: true });
          } else {
            fs.unlinkSync(entryPath);
          }
        }
      }
    } catch (e: any) {
      this.logger?.warn?.(`[OpenClaw] cleanupOldFiles 失败: ${e?.message || e}`);
    }
  }
}
