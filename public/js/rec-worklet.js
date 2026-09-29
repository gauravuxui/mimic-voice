// Taps the mic in 1024-sample batches, tagged with the audio-clock frame they start at.
class RecTap extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buf = new Float32Array(1024);
    this.n = 0;
    this.start = 0;
  }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (ch) {
      if (this.n === 0) this.start = currentFrame;
      this.buf.set(ch, this.n);
      this.n += ch.length;
      if (this.n >= this.buf.length) {
        this.port.postMessage({ f: this.start, d: this.buf.slice(0, this.n) });
        this.n = 0;
      }
    }
    return true;
  }
}
registerProcessor('rec-tap', RecTap);
