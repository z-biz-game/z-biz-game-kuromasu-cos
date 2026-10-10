// Synthesised feedback, no sample files. A puzzle game's sound is a *state* readout —
// "a square got inked", "that ink breaks a number", "every number adds up" — and each of those
// is one short envelope, so a synth keeps the artifact small and the vocabulary honest.

let ctx = null;
let master = null;
let enabled = true;
// 静音偏好：读回存档。放在模块顶层，这样每次 init（首屏、开局、重开）都拿到同一个答案，
// 重开一局不会把玩家的静音选择洗掉。
try {
  if (localStorage.getItem('cos.mute') === '1') enabled = false;
} catch { /* 读不到就沿用默认开声 */ }


// 静音是真的把设备停下来：`enabled` 为假时这里直接给 null，于是 tone() 一个振荡器节点都不会建，
// ctx 也留在 suspended。只把 master gain 设 0 是假静音——节点还在建、还在跑，只是听不见，
// 而且它随时能被下一次调用顺手 resume 回来。
function audio() {
  // 静音态第一行就返回：既不把已挂起的 ctx 拉起来，也不新建节点。
  // 这条比 "gain 设 0" 强一档——静音时这个 AudioContext 根本没有在跑。
  if (!enabled) return null;
  if (typeof AudioContext === 'undefined' && typeof webkitAudioContext === 'undefined') return null;
  if (!ctx) {
    const Ctor = typeof AudioContext !== 'undefined' ? AudioContext : webkitAudioContext;
    try {
      ctx = new Ctor();
      master = ctx.createGain();
      master.gain.value = 0.5;
      master.connect(ctx.destination);
    } catch {
      return null;
    }
  }
  if (ctx.state === 'suspended') ctx.resume().catch(() => {});
  return ctx;
}

// One oscillator with a two-point pitch glide and an exponential decay. Everything below is
// a call to this; adding a second voice shape is how a game ends up with sounds that do not
// belong to the same instrument.
function tone({ f0, f1 = f0, dur = 0.12, type = 'sine', gain = 0.22, delay = 0 }) {
  const ac = audio();
  // 静音态走到这里 ac 已经是 null：一个振荡器都不会建。这里不再要求 state==='running'——
  // 首次手势上 resume() 是异步的，卡这个条件会把玩家的第一声弄丢（挂在 suspended 的 ctx 上
  // 是合法的，事件会在它真正跑起来那一刻按 currentTime 兑现）。
  if (!ac || !enabled) return;
  const t = ac.currentTime + delay;
  const osc = ac.createOscillator();
  const vol = ac.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(f0, t);
  osc.frequency.exponentialRampToValueAtTime(Math.max(40, f1), t + dur);
  vol.gain.setValueAtTime(0.0001, t);
  vol.gain.exponentialRampToValueAtTime(gain, t + 0.012);
  vol.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  osc.connect(vol).connect(master);
  built++;
  osc.start(t);
  osc.stop(t + dur + 0.02);
}

export const Sound = {
  // 开关一按就落到 AudioContext 的状态上：开→resume，关→suspend。
  setEnabled(v) {
    const on = !!v;
    if (on === enabled) return;
    enabled = on;
    // 真静音：停掉 AudioContext 本身（时钟停、图不跑），不是把音量拧到 0。
    if (ctx) {
      if (on) {
        if (ctx.state === 'suspended' && ctx.resume) ctx.resume().catch(() => {});
      } else if (ctx.state === 'running' && ctx.suspend) {
        ctx.suspend().catch(() => {});
      }
    }
    // 偏好落盘：刷新页面后 init 要能读回静音态，不能自己弹回来。
    try {
      localStorage.setItem('cos.mute', on ? '1' : '0');
    } catch { /* 隐私模式下写不进去也不该炸游戏 */ }
  },
  enabled: () => enabled,
  muted: () => !enabled,
  toggleMute() {
    Sound.setEnabled(!enabled);
    return !enabled;
  },
  // 这两个是"真停了"的可验证出口：state 读得出 suspended / running。
  suspend() {
    if (ctx && ctx.state === 'running') ctx.suspend().catch(() => {});
  },
  resume() {
    if (ctx && ctx.state === 'suspended') ctx.resume().catch(() => {});
  },
  contextState: () => (ctx ? ctx.state : 'none'),
  // 建了多少个振荡器：静音态必须一个都不涨，这是本文件唯一诚实的自检。
  voices: () => built,

  place() {
    tone({ f0: 520, f1: 880, dur: 0.14, type: 'triangle', gain: 0.2 });
  },
  rub() {
    tone({ f0: 300, f1: 240, dur: 0.07, type: 'square', gain: 0.07 });
  },
  erase() {
    tone({ f0: 240, f1: 180, dur: 0.08, type: 'sine', gain: 0.1 });
  },
  undo() {
    tone({ f0: 420, f1: 300, dur: 0.11, type: 'triangle', gain: 0.13 });
  },
  // Two detuned voices: an interval that is deliberately unpleasant, for the one thing the
  // player must notice without looking.
  conflict() {
    tone({ f0: 200, f1: 150, dur: 0.16, type: 'sawtooth', gain: 0.11 });
    tone({ f0: 214, f1: 158, dur: 0.16, type: 'sawtooth', gain: 0.09, delay: 0.01 });
  },
  hint() {
    tone({ f0: 760, f1: 1020, dur: 0.16, type: 'sine', gain: 0.16 });
    tone({ f0: 1140, dur: 0.1, type: 'sine', gain: 0.07, delay: 0.06 });
  },
  win() {
    [523, 659, 784, 1046].forEach((f, i) => tone({ f0: f, dur: 0.26, type: 'triangle', gain: 0.17, delay: i * 0.09 }));
  },
};
