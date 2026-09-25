export class GameAudio {
  ctx?: AudioContext;
  master?: GainNode;
  ambient?: GainNode;
  enabled = true;
  active = false;
  async unlock() {
    try {
      if (!this.ctx) {
        this.ctx = new AudioContext();
        this.master = this.ctx.createGain(); this.master.gain.value = this.enabled ? .22 : 0;
        this.master.connect(this.ctx.destination);
        const buffer = this.ctx.createBuffer(1, this.ctx.sampleRate * 3, this.ctx.sampleRate);
        const data = buffer.getChannelData(0); let last = 0;
        for (let i = 0; i < data.length; i++) { last = (last + (Math.random() * 2 - 1) * .035) / 1.025; data[i] = last; }
        const source = this.ctx.createBufferSource(); source.buffer = buffer; source.loop = true;
        this.ambient = this.ctx.createGain(); this.ambient.gain.value = 0;
        source.connect(this.ambient); this.ambient.connect(this.master); source.start();
      }
      await this.ctx.resume(); this.setActive(this.active);
    } catch { /* Audio is optional when autoplay or browser policies block it. */ }
  }
  toggle() { this.enabled = !this.enabled; if (this.master) this.master.gain.value = this.enabled ? .22 : 0; }
  setActive(value: boolean) { this.active = value; if (this.ambient && this.ctx) this.ambient.gain.setTargetAtTime(value ? .7 : 0, this.ctx.currentTime, .15); }
  sound(kind: string) {
    if (!this.ctx || !this.master || !this.enabled) return;
    const frequencies: Record<string, number[]> = { checkpoint: [440, 660, 880], star_collected: [880, 1320], collision: [100, 70], game_finish: [523, 659, 784, 1046], paddle: [160] };
    (frequencies[kind] || [440]).forEach((f, i) => {
      const osc = this.ctx!.createOscillator(), gain = this.ctx!.createGain(), t = this.ctx!.currentTime + i * .09;
      osc.type = kind === 'collision' ? 'triangle' : 'sine'; osc.frequency.setValueAtTime(f, t);
      gain.gain.setValueAtTime(0, t); gain.gain.linearRampToValueAtTime(kind === 'paddle' ? .12 : .35, t + .015); gain.gain.exponentialRampToValueAtTime(.001, t + .22);
      osc.connect(gain); gain.connect(this.master!); osc.start(t); osc.stop(t + .24);
    });
  }
}
