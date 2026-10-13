import { fork } from 'node:child_process';
import { EventEmitter } from 'node:events';
import type { HistoryImportWorkerProcess } from '../Services/AgentHistory/AgentHistoryImportQueueService';

export function launchNodeHistoryWorker(workerPath: string): HistoryImportWorkerProcess {
  const child = fork(workerPath, [], { stdio: ['ignore', 'inherit', 'inherit', 'ipc'], execArgv: [] });
  const worker = new EventEmitter();
  child.on('message', (message) => worker.emit('message', message));
  child.on('error', (error) => { if (worker.listenerCount('error')) worker.emit('error', error); });
  // A child's 'exit' can arrive before its last IPC message is read (seen on
  // Windows). 'close' follows the IPC channel, so the result is never lost.
  child.once('close', (code, signal) => worker.emit('exit', code ?? undefined, signal ?? undefined));
  return Object.assign(worker, {
    postMessage(message: unknown): void {
      if (child.connected) child.send(message as object, (error) => {
        if (error && child.connected) child.emit('error', error);
      });
    },
    kill(): void {
      child.kill();
    }
  });
}
