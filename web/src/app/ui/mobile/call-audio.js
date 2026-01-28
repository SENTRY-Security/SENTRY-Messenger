import { log } from '../../core/log.js';

const SOUND_SOURCES = {
  outgoing: '/assets/audio/call-out.mp3',
  incoming: '/assets/audio/call-in.mp3',
  accepted: '/assets/audio/accept.mp3',
  ended: '/assets/audio/end-call.mp3'
};

function createAudioElement(src, { loop = false } = {}) {
  if (typeof Audio === 'undefined') return null;
  try {
    const el = new Audio(src);
    el.loop = loop;
    el.preload = 'auto';
    el.playsInline = true;
    el.crossOrigin = 'anonymous';
    return el;
  } catch (err) {
    log({ callAudioInitError: err?.message || err, src });
    return null;
  }
}

function safePause(audio) {
  if (!audio) return;
  try {
    audio.pause();
    audio.currentTime = 0;
  } catch (err) {
    log({ callAudioPauseError: err?.message || err });
  }
}

export function createCallAudioManager() {
  if (typeof Audio === 'undefined') {
    const noop = () => {};
    return {
      playOutgoingLoop: noop,
      playIncomingLoop: noop,
      stopLoops: noop,
      playAcceptedTone: noop,
      playEndTone: noop,
      stopAll: noop,
      dispose: noop
    };
  }

  const players = new Map();
  let currentLoop = null;

  function ensurePlayer(key, { loop = false } = {}) {
    if (players.has(key)) return players.get(key);
    const src = SOUND_SOURCES[key];
    if (!src) return null;
    const audio = createAudioElement(src, { loop });
    if (!audio) return null;
    audio.loop = loop;
    players.set(key, audio);
    return audio;
  }

  function playLoop(key) {
    if (currentLoop === key) return;
    stopLoop();
    const audio = ensurePlayer(key, { loop: true });
    if (!audio) return;
    currentLoop = key;
    audio.loop = true;
    try {
      audio.currentTime = 0;
      const maybePromise = audio.play();
      if (maybePromise?.catch) {
        maybePromise.catch((err) => {
          log({ callAudioPlayError: err?.message || err, key });
          if (currentLoop === key) {
            currentLoop = null;
          }
        });
      }
    } catch (err) {
      log({ callAudioPlayError: err?.message || err, key });
      currentLoop = null;
    }
  }

  function stopLoop() {
    if (!currentLoop) return;
    const audio = players.get(currentLoop);
    safePause(audio);
    currentLoop = null;
  }

  function playOnce(key) {
    const audio = ensurePlayer(key, { loop: false });
    if (!audio) return;
    audio.loop = false;
    try {
      audio.currentTime = 0;
      const maybePromise = audio.play();
      if (maybePromise?.catch) {
        maybePromise.catch((err) => log({ callAudioPlayError: err?.message || err, key }));
      }
    } catch (err) {
      log({ callAudioPlayError: err?.message || err, key });
    }
  }

  function stopAll() {
    stopLoop();
    for (const audio of players.values()) {
      safePause(audio);
    }
  }

  function dispose() {
    stopAll();
    for (const audio of players.values()) {
      try {
        audio.src = '';
        audio.load();
      } catch {}
    }
    players.clear();
  }

  return {
    playOutgoingLoop() {
      playLoop('outgoing');
    },
    playIncomingLoop() {
      playLoop('incoming');
    },
    stopLoops() {
      stopLoop();
    },
    playAcceptedTone() {
      playOnce('accepted');
    },
    playEndTone() {
      playOnce('ended');
    },
    stopAll,
    dispose
  };
}
