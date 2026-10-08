import { fork } from 'node:child_process';
import type { HistoryImportWorkerProcess } from '../Services/AgentHistory/AgentHistoryImportQueueService';

export function launchNodeHistoryWorker(workerPath: string): HistoryImportWorkerProcess {
  const worker = fork(workerPath, [], { stdio: ['ignore', 'inherit', 'inherit', 'ipc'], execArgv: [] });
  return Object.assign(worker, {
    postMessage(message: unknown): void {
      if (worker.connected) worker.send(message as object, (error) => {
        if (error && worker.connected) worker.emit('error', error);
      });
    }
  });
}
