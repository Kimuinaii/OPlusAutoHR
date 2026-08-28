let callbackCounter = 0;

function unique(prefix) {
  return `${prefix}_${Date.now()}_${callbackCounter++}`;
}

export function hasKsu() {
  return typeof window.ksu !== "undefined" && typeof window.ksu.exec === "function";
}

export function exec(command, options = {}) {
  if (!hasKsu()) {
    return Promise.reject(new Error("KernelSU WebUI bridge is unavailable"));
  }
  return new Promise((resolve, reject) => {
    const cb = unique("oah_exec");
    window[cb] = (errno, stdout, stderr) => {
      delete window[cb];
      resolve({ errno, stdout, stderr });
    };
    try {
      window.ksu.exec(command, JSON.stringify(options), cb);
    } catch (e) {
      delete window[cb];
      reject(e);
    }
  });
}

export function toast(message) {
  try {
    if (window.ksu && window.ksu.toast) window.ksu.toast(String(message));
  } catch (_) {}
}

export function enableEdgeToEdge(enable = true) {
  try {
    if (window.ksu && window.ksu.enableEdgeToEdge) window.ksu.enableEdgeToEdge(enable);
  } catch (_) {}
}
