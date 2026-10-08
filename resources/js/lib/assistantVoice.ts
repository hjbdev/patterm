// One GPT-Live voice call. The browser owns the microphone and the WebRTC peer;
// Patterm relays only the offer and answer to the assistant's Codex thread, so
// audio flows directly between this client and OpenAI.
export type VoiceStatus = 'connecting' | 'connected' | 'ended' | 'failed';

export class AssistantVoiceSession {
  private peer: RTCPeerConnection | null = null;
  private microphone: MediaStream | null = null;
  private audio: HTMLAudioElement | null = null;
  private context: AudioContext | null = null;
  private output: AnalyserNode | null = null;
  private input: AnalyserNode | null = null;
  private readonly samples = new Uint8Array(512);
  private stopped = false;

  constructor(
    private readonly onStatus: (status: VoiceStatus, detail?: string) => void,
    private readonly controls: { hangUp(): void; toggleMute(): void } = { hangUp() {}, toggleMute() {} }
  ) {}

  async start(): Promise<void> {
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error('Voice needs microphone access, which browsers only allow over HTTPS or on localhost.');
    }
    this.onStatus('connecting');
    this.microphone = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } })
      .catch((error: unknown) => { throw microphoneError(error); });
    if (this.stopped) return this.release();
    this.context = new AudioContext();
    this.input = this.analyser(this.context.createMediaStreamSource(this.microphone));

    const peer = new RTCPeerConnection();
    this.peer = peer;
    peer.onconnectionstatechange = () => {
      if (this.stopped) return;
      if (peer.connectionState === 'connected') {
        this.claimMediaSession();
        this.onStatus('connected');
      }
      else if (peer.connectionState === 'failed') this.fail('The voice connection failed. Check that this network allows WebRTC.');
      else if (peer.connectionState === 'disconnected') this.onStatus('connecting');
    };
    peer.ontrack = (event) => {
      const stream = event.streams[0] ?? new MediaStream([event.track]);
      this.audio = new Audio();
      this.audio.autoplay = true;
      this.audio.srcObject = stream;
      void this.audio.play().catch(() => undefined);
      if (this.context) this.output = this.analyser(this.context.createMediaStreamSource(stream));
    };
    for (const track of this.microphone.getAudioTracks()) peer.addTrack(track, this.microphone);
    // OpenAI's WebRTC endpoint expects the client to open its events channel.
    peer.createDataChannel('oai-events');
    await peer.setLocalDescription(await peer.createOffer());
    const answer = await window.patterm.call('patterm.assistant.voice.start', { sdp: peer.localDescription?.sdp ?? '' }) as { sdp?: unknown };
    if (this.stopped) return;
    if (typeof answer?.sdp !== 'string') throw new Error('The assistant did not answer the voice call');
    await peer.setRemoteDescription({ type: 'answer', sdp: answer.sdp });
  }

  setMuted(muted: boolean): void {
    for (const track of this.microphone?.getAudioTracks() ?? []) track.enabled = !muted;
    void (navigator.mediaSession as CallMediaSession | undefined)?.setMicrophoneActive?.(!muted)?.catch?.(() => undefined);
  }

  // Loudness from 0 to 1 for the speaker and the microphone, read per frame.
  levels(): { output: number; input: number } {
    return { output: this.level(this.output), input: this.level(this.input) };
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    this.release();
    this.onStatus('ended');
    await window.patterm.call('patterm.assistant.voice.stop', {}).catch(() => undefined);
  }

  private fail(detail: string): void {
    if (this.stopped) return;
    this.stopped = true;
    this.release();
    this.onStatus('failed', detail);
    void window.patterm.call('patterm.assistant.voice.stop', {}).catch(() => undefined);
  }

  private analyser(source: MediaStreamAudioSourceNode): AnalyserNode {
    const node = source.context.createAnalyser();
    node.fftSize = 512;
    source.connect(node);
    return node;
  }

  private level(node: AnalyserNode | null): number {
    if (!node) return 0;
    node.getByteTimeDomainData(this.samples);
    let sum = 0;
    for (const sample of this.samples) {
      const value = (sample - 128) / 128;
      sum += value * value;
    }
    return Math.min(1, Math.sqrt(sum / this.samples.length) * 4);
  }

  // Presents the call to the operating system, so it keeps running with call
  // controls in the notification shade or lock screen while another app or tab
  // is in front. Browsers keep an active WebRTC call's audio running in the
  // background; this makes it visible and controllable there.
  private claimMediaSession(): void {
    const media = navigator.mediaSession as CallMediaSession | undefined;
    if (!media || typeof MediaMetadata === 'undefined') return;
    media.metadata = new MediaMetadata({ title: 'Patterm assistant', artist: 'Voice session' });
    media.playbackState = 'playing';
    const handle = (action: string, handler: (() => void) | null) => {
      try { media.setActionHandler(action as MediaSessionAction, handler); } catch { /* unsupported action */ }
    };
    handle('hangup', () => this.controls.hangUp());
    handle('togglemicrophone', () => this.controls.toggleMute());
    handle('pause', () => this.controls.toggleMute());
    handle('play', () => this.controls.toggleMute());
    void media.setMicrophoneActive?.(true)?.catch?.(() => undefined);
  }

  private releaseMediaSession(): void {
    const media = navigator.mediaSession as CallMediaSession | undefined;
    if (!media) return;
    for (const action of ['hangup', 'togglemicrophone', 'pause', 'play']) {
      try { media.setActionHandler(action as MediaSessionAction, null); } catch { /* unsupported action */ }
    }
    media.metadata = null;
    media.playbackState = 'none';
  }

  private release(): void {
    this.releaseMediaSession();
    this.peer?.close();
    this.peer = null;
    for (const track of this.microphone?.getTracks() ?? []) track.stop();
    this.microphone = null;
    if (this.audio) this.audio.srcObject = null;
    this.audio = null;
    void this.context?.close().catch(() => undefined);
    this.context = null;
    this.output = null;
    this.input = null;
  }
}

// Browsers report a dismissed or blocked prompt as terse DOM errors.
function microphoneError(error: unknown): Error {
  const name = error instanceof DOMException ? error.name : '';
  if (name === 'NotAllowedError') return new Error('Microphone access was not allowed. Allow it for this site, then try again.');
  if (name === 'NotFoundError') return new Error('No microphone was found. Connect one, then try again.');
  if (name === 'NotReadableError') return new Error('The microphone is in use by another app.');
  return error instanceof Error ? error : new Error(String(error));
}

// Call actions from the Media Session spec that TypeScript's DOM types lack.
type CallMediaSession = MediaSession & { setMicrophoneActive?(active: boolean): Promise<void> | void };
