import { execFile } from 'child_process';
import { promisify } from 'util';
import { IS_WINDOWS } from '../constants';

const execFileAsync = promisify(execFile);

export interface ScanResult {
  ports: Set<number>;
  pidMap: Map<number, Set<number>>;
  processMap: Map<number, string>;
}

/** Scan listening TCP ports using platform-appropriate tools. */
export function scanPorts(): Promise<ScanResult> {
  return IS_WINDOWS ? scanWindows() : scanUnix();
}

/** Kill a process by PID. */
export async function killPid(pid: number): Promise<void> {
  if (IS_WINDOWS) {
    await execFileAsync('taskkill', ['/F', '/PID', String(pid)]);
  } else {
    process.kill(pid, 'SIGTERM');
  }
}

// ── macOS / Linux ──

async function scanUnix(): Promise<ScanResult> {
  const { stdout } = await execFileAsync('lsof', [
    '-iTCP', '-sTCP:LISTEN', '-nP', '-F', 'pcn',
  ]);

  const ports = new Set<number>();
  const pidMap = new Map<number, Set<number>>();
  const processMap = new Map<number, string>();
  const lines = stdout.split('\n');
  let currentPid = 0;
  let currentCmd = '';

  for (const line of lines) {
    if (line.startsWith('p')) {
      currentPid = Number(line.slice(1));
    } else if (line.startsWith('c')) {
      currentCmd = line.slice(1);
    } else if (line.startsWith('n')) {
      const match = line.match(/:(\d+)$/);
      if (match) {
        const port = Number(match[1]);
        if (port >= 1024 && port <= 65535) {
          ports.add(port);
          if (currentPid) {
            if (!pidMap.has(port)) pidMap.set(port, new Set());
            pidMap.get(port)!.add(currentPid);
          }
          if (currentCmd && !processMap.has(port)) {
            processMap.set(port, currentCmd);
          }
        }
      }
    }
  }

  return { ports, pidMap, processMap };
}

// ── Windows ──

async function scanWindows(): Promise<ScanResult> {
  const { stdout } = await execFileAsync('netstat', ['-aon', '-p', 'TCP']);

  const ports = new Set<number>();
  const pidMap = new Map<number, Set<number>>();
  const pidSet = new Set<number>();

  for (const line of stdout.split('\n')) {
    if (!line.includes('LISTENING')) continue;
    const parts = line.trim().split(/\s+/);
    if (parts.length < 5) continue;
    const addrPart = parts[1];
    const pid = Number(parts[4]);
    const portMatch = addrPart.match(/:(\d+)$/);
    if (!portMatch) continue;
    const port = Number(portMatch[1]);
    if (port < 1024 || port > 65535) continue;
    ports.add(port);
    if (pid) {
      if (!pidMap.has(port)) pidMap.set(port, new Set());
      pidMap.get(port)!.add(pid);
      pidSet.add(pid);
    }
  }

  const processMap = new Map<number, string>();
  if (pidSet.size > 0) {
    try {
      const filters = [...pidSet].slice(0, 50).map(p => `/FI "PID eq ${p}"`);
      const { stdout: tlOut } = await execFileAsync('tasklist', [
        '/FO', 'CSV', '/NH', ...filters.flatMap(f => f.split(' ')),
      ], { shell: true });
      for (const line of tlOut.split('\n')) {
        const match = line.match(/^"([^"]+)","(\d+)"/);
        if (match) {
          const name = match[1].replace(/\.exe$/i, '');
          const pid = Number(match[2]);
          for (const [port, pids] of pidMap) {
            if (pids.has(pid) && !processMap.has(port)) {
              processMap.set(port, name);
            }
          }
        }
      }
    } catch {
      // tasklist failed — continue without process names
    }
  }

  return { ports, pidMap, processMap };
}
