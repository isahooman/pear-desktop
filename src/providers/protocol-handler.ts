import path from 'node:path';

import { app, type BrowserWindow } from 'electron';

import { getSongControls } from './song-controls';

export const APP_PROTOCOL =
  '\u0079\u006f\u0075\u0074\u0075\u0062\u0065\u006d\u0075\u0073\u0069\u0063';

let protocolHandler: ((cmd: string, ...args: string[]) => void) | undefined;

export function setupProtocolHandler(win: BrowserWindow) {
  if (process.defaultApp && process.argv.length >= 2) {
    app.setAsDefaultProtocolClient(APP_PROTOCOL, process.execPath, [
      path.resolve(process.argv[1]),
    ]);
  } else {
    app.setAsDefaultProtocolClient(APP_PROTOCOL);
  }

  const songControls = getSongControls(win);

  protocolHandler = ((cmd: keyof typeof songControls, ...args) => {
    if (Object.keys(songControls).includes(cmd)) {
      // @ts-expect-error: cmd is a key of songControls
      songControls[cmd](...args);
    }
  }) as (cmd: string, ...args: string[]) => void;
}

/**
 * Finds a music link (e.g. https://music.youtube.com/watch?v=...) among
 * command line arguments, so it can be opened by the app.
 */
export function findMusicUrl(args: string[]): string | undefined {
  for (const arg of args) {
    try {
      const url = new URL(arg);
      if (
        url.protocol === 'https:' &&
        url.hostname === 'music.youtube.com'
      ) {
        return url.toString();
      }
    } catch {
      // not a URL
    }
  }
  return undefined;
}

export function handleProtocol(cmd: string, ...args: string[]) {
  protocolHandler?.(cmd, ...args);
}

export function changeProtocolHandler(
  f: (cmd: string, ...args: string[]) => void,
) {
  protocolHandler = f;
}
