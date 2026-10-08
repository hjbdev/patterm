"""Measure live sidecar request latency and scheduling with synthetic PTYs.

Run with --sidecar pointing to a release binary. No application DB or service is used.
"""
import argparse
import json
import os
import select
import statistics
import struct
import subprocess
import time


class Sidecar:
    def __init__(self, binary):
        self.child = subprocess.Popen([binary], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        self.buffer = b''
        self.next_id = 0
        self.responses = {}
        self.damage_frames = 0
        self.max_threads = 0
        self.request('terminal.ping')

    def send(self, method, params=None):
        self.next_id += 1
        self.child.stdin.write((json.dumps({'id': self.next_id, 'method': method, 'params': params or {}}) + '\n').encode())
        self.child.stdin.flush()
        return self.next_id

    def pump(self, timeout=5):
        if not select.select([self.child.stdout], [], [], timeout)[0]:
            raise TimeoutError('No sidecar response')
        chunk = os.read(self.child.stdout.fileno(), 1048576)
        if not chunk:
            raise RuntimeError(self.child.stderr.read().decode())
        self.buffer += chunk
        while len(self.buffer) >= 4:
            size = struct.unpack_from('<I', self.buffer)[0]
            if len(self.buffer) < 4 + size:
                break
            kind, payload = self.buffer[4], self.buffer[5:4 + size]
            self.buffer = self.buffer[4 + size:]
            if kind == 1:
                response = json.loads(payload)
                self.responses[response['id']] = response
            elif kind == 5:
                self.damage_frames += 1

    def wait(self, request_id):
        deadline = time.monotonic() + 10
        while request_id not in self.responses:
            self.pump(max(.001, deadline - time.monotonic()))
            if time.monotonic() > deadline:
                raise TimeoutError('Request timed out')
        response = self.responses.pop(request_id)
        if 'error' in response:
            raise RuntimeError(response['error'])
        return response['result']

    def request(self, method, params=None):
        return self.wait(self.send(method, params))

    def spawn(self, **params):
        return self.request('terminal.process.spawn', {'command': '/bin/cat', 'cols': 80, 'rows': 24, **params})['process_id']

    def cpu_ms(self):
        fields = open(f'/proc/{self.child.pid}/stat').read().split()
        return (int(fields[13]) + int(fields[14])) * 1000 / os.sysconf('SC_CLK_TCK')

    def threads(self):
        return len(os.listdir(f'/proc/{self.child.pid}/task'))

    def close(self):
        self.child.terminate()
        try:
            self.child.wait(timeout=3)
        except subprocess.TimeoutExpired:
            self.child.kill()
            self.child.wait()
        self.child.stdin.close()
        self.child.stdout.close()
        self.child.stderr.close()


def summary(values):
    return {'median': statistics.median(values), 'p95': sorted(values)[int(len(values) * .95 + .999999) - 1], 'samples': values}


def run(binary, samples):
    result = {'sidecar': binary, 'samples': samples, 'boundary': 'live release sidecar, synthetic PTYs; CPU includes sidecar threads, excludes child command CPU'}
    latencies, submissions, timer_cpu, timer_threads, timer_frames = [], [], [], [], []
    # Fresh sidecar for each independent submission trial.
    for _ in range(samples):
        sidecar = Sidecar(binary)
        try:
            agent = sidecar.spawn(kind='agent')
            other = sidecar.spawn()
            start = time.perf_counter()
            submit = sidecar.send('terminal.process.input', {'process_id': agent, 'kind': 'paste', 'text': 'runtime benchmark', 'submit': True})
            ping = sidecar.send('terminal.process.status', {'process_id': other})
            sidecar.wait(ping)
            latencies.append((time.perf_counter() - start) * 1000)
            sidecar.wait(submit)
            submissions.append((time.perf_counter() - start) * 1000)
        finally:
            sidecar.close()
    result['other_terminal_status_ms'] = summary(latencies)
    result['submission_response_ms'] = summary(submissions)
    # Eight visible 60 Hz PTYs for one second after a short warm-up.
    command = 'import time\nfor i in range(1000):\n print("\\rframe-%06d" % i, end="", flush=True)\n time.sleep(1/60)'
    for _ in range(samples):
        sidecar = Sidecar(binary)
        try:
            for _ in range(8):
                process_id = sidecar.spawn(command='/usr/bin/python3', args=['-u', '-c', command])
                sidecar.request('terminal.process.subscribe', {'process_id': process_id, 'subscribed': True})
            warmup = time.monotonic() + .2
            while time.monotonic() < warmup:
                sidecar.pump()
            start_cpu, start_frames = sidecar.cpu_ms(), sidecar.damage_frames
            deadline = time.monotonic() + 1
            peak = sidecar.threads()
            while time.monotonic() < deadline:
                sidecar.pump()
                peak = max(peak, sidecar.threads())
            timer_cpu.append(sidecar.cpu_ms() - start_cpu)
            timer_threads.append(peak)
            timer_frames.append(sidecar.damage_frames - start_frames)
        finally:
            sidecar.close()
    result['eight_terminals_cpu_ms_per_second'] = summary(timer_cpu)
    result['eight_terminals_peak_threads'] = summary(timer_threads)
    result['eight_terminals_frames_per_second'] = summary(timer_frames)
    print(json.dumps(result, indent=2))


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--sidecar', required=True)
    parser.add_argument('--samples', type=int, default=10)
    args = parser.parse_args()
    run(args.sidecar, args.samples)
