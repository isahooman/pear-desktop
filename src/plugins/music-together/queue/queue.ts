import { t } from '@/i18n';

import { getMusicQueueRenderer } from './song';
import {
  alignOwners,
  getItemVideoIds,
  hashVideoIds,
  mapQueueItem,
} from './utils';

import { getDefaultProfile, type Profile, type VideoData } from '../types';

import type { ConnectionEventUnion } from '@/plugins/music-together/connection';
import type { QueueItem } from '@/types/datahost-get-state';
import type { QueueElement, Store } from '@/types/queue';

const getHeaderPayload = (() => {
  let payload: {
    items?: QueueItem[] | undefined;
    title: {
      runs: {
        text: string;
      }[];
    };
    subtitle: {
      runs: {
        text: string;
      }[];
    };
    buttons: {
      chipCloudChipRenderer: {
        style: {
          styleType: string;
        };
        text: {
          runs: {
            text: string;
          }[];
        };
        navigationEndpoint: {
          saveQueueToPlaylistCommand: unknown;
        };
        icon: {
          iconType: string;
        };
        accessibilityData: {
          accessibilityData: {
            label: string;
          };
        };
        isSelected: boolean;
        uniqueId: string;
      };
    }[];
  } | null = null;

  return () => {
    if (!payload) {
      payload = {
        title: {
          runs: [
            {
              text: t('plugins.music-together.internal.track-source'),
            },
          ],
        },
        subtitle: {
          runs: [
            {
              text: t('plugins.music-together.name'),
            },
          ],
        },
        buttons: [
          {
            chipCloudChipRenderer: {
              style: {
                styleType: 'STYLE_TRANSPARENT',
              },
              text: {
                runs: [
                  {
                    text: t('plugins.music-together.internal.save'),
                  },
                ],
              },
              navigationEndpoint: {
                saveQueueToPlaylistCommand: {},
              },
              icon: {
                iconType: 'ADD_TO_PLAYLIST',
              },
              accessibilityData: {
                accessibilityData: {
                  label: t('plugins.music-together.internal.save'),
                },
              },
              isSelected: false,
              uniqueId: t('plugins.music-together.internal.save'),
            },
          },
        ],
      };
    }

    return payload;
  };
})();

export type QueueOptions = {
  videoList?: VideoData[];
  owner?: Profile;
  queue?: QueueElement;
  getProfile: (id: string) => Profile | undefined;
};
export type QueueEventListener = (event: ConnectionEventUnion) => void;

// one entry per queue item; songs with a music video are wrapped
const QUEUE_ENTRY_SELECTOR =
  '#contents > ytmusic-player-queue-item,#contents > ytmusic-playlist-panel-video-wrapper-renderer';
const QUEUE_ITEM_TAG = 'ytmusic-player-queue-item';
const OWNER_CLASS = 'music-together-owner';
const NAME_CLASS = 'music-together-name';

const setAttr = (element: Element, name: string, value: string) => {
  if (element.getAttribute(name) !== value) element.setAttribute(name, value);
};

const isOwnLabel = (node: Node) =>
  node instanceof Element &&
  (node.classList.contains(OWNER_CLASS) || node.classList.contains(NAME_CLASS));

const containsQueueItem = (node: Node) =>
  node instanceof Element &&
  (node.matches(QUEUE_ITEM_TAG) || !!node.querySelector(QUEUE_ITEM_TAG));

export class Queue {
  private readonly queue: QueueElement;

  private originalDispatch?: (obj: {
    type: string;
    payload?: { items?: QueueItem[] | undefined };
  }) => void;

  private internalDispatch = false;
  private ignoreFlag = false;
  private listeners: QueueEventListener[] = [];

  private owner: Profile | null;
  private readonly getProfile: (id: string) => Profile | undefined;

  private ownerObserver?: MutationObserver;
  private unsubscribeStore?: () => void;
  private ownerSyncFrame?: number;

  private idCache?: {
    items: QueueItem[];
    ids: string[];
    hash: string | undefined;
  };

  constructor(options: QueueOptions) {
    this.getProfile = options.getProfile;
    this.queue =
      options.queue ?? document.querySelector<QueueElement>('#queue')!;
    this.owner = options.owner ?? null;
    this._videoList = options.videoList ?? [];
  }

  private _videoList: VideoData[] = [];

  /* utils */
  get videoList() {
    return this._videoList;
  }

  get selectedIndex() {
    return (
      mapQueueItem(
        (it) => it?.selected,
        this.queue.queue.store.store.getState().queue.items,
      ).findIndex(Boolean) ?? 0
    );
  }

  get rawItems() {
    return this.queue?.queue.store.store.getState().queue.items;
  }

  get flatItems() {
    return mapQueueItem((it) => it, this.rawItems);
  }

  /**
   * Video ids in queue order. Cached per store snapshot, because this is read
   * every second while hosting and walking a long queue each time adds up.
   */
  get videoIds(): string[] {
    const items = this.rawItems;
    if (!this.idCache || this.idCache.items !== items) {
      this.idCache = {
        items,
        ids: this.flatItems.map((it) => it?.videoId ?? ''),
        hash: undefined,
      };
    }
    return this.idCache.ids;
  }

  /** Fingerprint of the queue order, see `hashVideoIds`. */
  get queueHash() {
    const ids = this.videoIds;
    // `videoIds` just refreshed the cache
    const cache = this.idCache!;
    cache.hash ??= hashVideoIds(ids);
    return cache.hash;
  }

  /**
   * Finds where a song is in this queue. Positions can differ between users
   * (e.g. unavailable songs get dropped), so prefer the entry with the same
   * video id closest to `hint`. Returns -1 if the song isn't in the queue.
   */
  resolveIndex(hint: number, videoId?: string) {
    const ids = this.videoIds;
    if (!videoId) return hint >= 0 && hint < ids.length ? hint : -1;
    if (ids[hint] === videoId) return hint;

    let best = -1;
    ids.forEach((id, i) => {
      if (id !== videoId) return;
      if (best < 0 || Math.abs(i - hint) < Math.abs(best - hint)) best = i;
    });
    return best;
  }

  /**
   * Current queue as shown in the player, with known owners attached. Owners
   * follow their songs, not positions, so songs that YouTube Music moved or
   * added on its own can't take over someone else's owner.
   */
  getSnapshot(): VideoData[] {
    return alignOwners(
      this.rawItems.map(getItemVideoIds),
      this._videoList,
      this.owner?.id ?? '',
    );
  }

  setOwner(owner: Profile) {
    this.owner = owner;
  }

  /* public */
  async setVideoList(videoList: VideoData[], sync = true) {
    this._videoList = videoList;

    if (sync) await this.syncVideo();
  }

  /**
   * Adds songs to the queue. With `replace`, they replace the whole queue in
   * one step, so a queue can never end up mixing two users' picks.
   */
  async addVideos(videos: VideoData[], index?: number, replace = false) {
    const response = await getMusicQueueRenderer(
      videos.map((it) => it.videoId),
    );
    if (!response) return false;

    const items = response.queueDatas
      .map((it) => it?.content)
      .filter(Boolean) as QueueItem[];
    if (!items.length) return false;

    // get_queue may drop unavailable videos or return another version of a
    // song (e.g. its music video), so record what was actually added
    const addedIds = items.map(getItemVideoIds);
    const added: VideoData[] =
      addedIds.length === videos.length
        ? addedIds.map((ids, i) => ({
            videoId: ids[0] ?? videos[i].videoId,
            ownerId: videos[i].ownerId,
          }))
        : alignOwners(
            addedIds,
            videos,
            videos[0]?.ownerId ?? this.owner?.id ?? '',
          );

    // owners of the songs already there, matched before the queue changes
    const videoList = replace ? [] : this.getSnapshot();

    this.internalDispatch = true;
    if (replace) this.queue?.dispatch({ type: 'CLEAR' });

    const state = this.queue.queue.store.store.getState();
    const length = state.queue.items.length;
    const insertAt = Math.min(index ?? length, length);

    this.queue?.dispatch({
      type: 'ADD_ITEMS',
      payload: {
        nextQueueItemId: state.queue.nextQueueItemId,
        index: insertAt,
        items,
        shuffleEnabled: false,
        shouldAssignIds: true,
      },
    });
    videoList.splice(insertAt, 0, ...added);
    this._videoList = videoList;
    this.internalDispatch = false;
    setTimeout(() => {
      this.initQueue();
      this.syncQueueOwner();
    }, 0);

    return true;
  }

  removeVideo(index: number) {
    this.internalDispatch = true;
    this._videoList = this.getSnapshot();
    this._videoList.splice(index, 1);
    this.queue?.dispatch({
      type: 'REMOVE_ITEM',
      payload: index,
    });
    this.internalDispatch = false;
    setTimeout(() => {
      this.initQueue();
      this.syncQueueOwner();
    }, 0);
  }

  setIndex(index: number) {
    this.internalDispatch = true;
    this.queue?.dispatch({
      type: 'SET_INDEX',
      payload: index,
    });
    this.internalDispatch = false;
    this.showPlayer();
  }

  showPlayer() {
    if (!this.queue || this.videoIds.length === 0) return;

    const state = this.queue.queue.store.store.getState();
    if (state.navigation?.playerUiState !== 'INACTIVE') return;

    this.internalDispatch = true;
    this.queue.dispatch({
      type: 'SET_PLAYER_UI_STATE',
      payload: 'PLAYER_BAR_ONLY',
    });
    this.internalDispatch = false;
  }

  moveItem(fromIndex: number, toIndex: number) {
    this.internalDispatch = true;
    this._videoList = this.getSnapshot();
    const [data] = this._videoList.splice(fromIndex, 1);
    if (data) this._videoList.splice(toIndex, 0, data);
    this.queue?.dispatch({
      type: 'MOVE_ITEM',
      payload: {
        fromIndex,
        toIndex,
      },
    });
    this.internalDispatch = false;
    setTimeout(() => {
      this.initQueue();
      this.syncQueueOwner();
    }, 0);
  }

  clear() {
    this.internalDispatch = true;
    this._videoList = [];
    this.queue?.dispatch({
      type: 'CLEAR',
    });
    this.internalDispatch = false;
  }

  on(listener: QueueEventListener) {
    if (!this.listeners.includes(listener)) {
      this.listeners.push(listener);
    }
  }

  off(listener: QueueEventListener) {
    this.listeners = this.listeners.filter((it) => it !== listener);
  }

  rollbackInjection() {
    if (!this.queue) {
      console.error('Queue is not initialized!');
      return;
    }

    if (this.originalDispatch)
      this.queue.queue.store.store.dispatch = this
        .originalDispatch as Store['dispatch'];
  }

  injection() {
    if (!this.queue) {
      console.error('Queue is not initialized!');
      return;
    }

    this.originalDispatch = this.queue.queue.store.store.dispatch;
    this.queue.queue.store.store.dispatch = (event) => {
      if (!this.queue || !this.owner) {
        console.error('Queue is not initialized!');
        return;
      }

      if (!this.internalDispatch) {
        if (event.type === 'CLEAR') {
          this.ignoreFlag = true;
          this.broadcast({
            type: 'CLEAR_QUEUE',
            payload: null,
          });
          return;
        }
        if (event.type === 'ADD_ITEMS') {
          // Local state is only updated once the host echoes the event back
          if (this.ignoreFlag) {
            this.ignoreFlag = false;
            const items = (
              event.payload! as {
                items: QueueItem[];
              }
            ).items;
            const videoList = mapQueueItem(
              (it) =>
                ({
                  videoId: it!.videoId,
                  ownerId: this.owner!.id,
                }) satisfies VideoData,
              items,
            );
            // the queue is cleared first, so jump to the song that was played
            const index = Math.max(
              0,
              mapQueueItem((it) => it?.selected, items).findIndex(Boolean),
            );

            if (videoList.length > 0) {
              this.broadcast({
                // play: replaces the queue in one step, even if someone else
                // started a song at the same time
                type: 'ADD_SONGS',
                payload: {
                  videoList,
                  replace: true,
                },
                after: [
                  {
                    type: 'SET_INDEX',
                    payload: {
                      index,
                      videoId: videoList[index]?.videoId,
                    },
                  },
                ],
              });
            }
          } else if (
            (
              event.payload as {
                items: unknown[];
              }
            ).items.length === 1
          ) {
            const videoList = mapQueueItem(
              (it) =>
                ({
                  videoId: it!.videoId,
                  ownerId: this.owner!.id,
                }) satisfies VideoData,
              (
                event.payload! as {
                  items: QueueItem[];
                }
              ).items,
            );
            this.broadcast({
              // add playlist
              type: 'ADD_SONGS',
              payload: {
                index:
                  event.payload && Object.hasOwn(event.payload, 'index')
                    ? (
                        event.payload as {
                          index: number;
                        }
                      ).index
                    : undefined,
                videoList,
              },
            });
          }

          return;
        }

        if (event.type === 'MOVE_ITEM') {
          this.broadcast({
            type: 'MOVE_SONG',
            payload: {
              fromIndex: (
                event.payload as {
                  fromIndex: number;
                }
              ).fromIndex,
              toIndex: (
                event.payload as {
                  toIndex: number;
                }
              ).toIndex,
            },
          });
          return;
        }
        if (event.type === 'REMOVE_ITEM') {
          this.broadcast({
            type: 'REMOVE_SONG',
            payload: {
              index: event.payload as number,
            },
          });
          return;
        }
        if (event.type === 'SET_INDEX') {
          this.broadcast({
            type: 'SYNC_PROGRESS',
            payload: {
              index: event.payload as number,
            },
          });
          return;
        }

        if (event.type === 'SET_HEADER') event.payload = getHeaderPayload();
        if (event.type === 'ADD_STEERING_CHIPS') {
          event.type = 'CLEAR_STEERING_CHIPS';
          event.payload = undefined;
        }
        if (event.type === 'SET_PLAYER_UI_STATE') {
          if (
            (event.payload as string) === 'INACTIVE' &&
            this.videoList.length > 0
          ) {
            return;
          }
        }
        if (event.type === 'HAS_SHOWN_AUTOPLAY') return;
        if (event.type === 'ADD_AUTOMIX_ITEMS') return;
      }

      const fakeContext = {
        ...this.queue,
        queue: {
          ...this.queue.queue,
          store: {
            ...this.queue.queue.store,
            dispatch: this.originalDispatch,
          },
        },
      };
      this.originalDispatch?.call(
        fakeContext,
        event as {
          type: string;
          payload?: { items?: QueueItem[] | undefined } | undefined;
        },
      );
    };
  }

  /* sync */
  initQueue() {
    if (!this.queue) return;

    this.internalDispatch = true;
    this.queue.dispatch({
      type: 'HAS_SHOWN_AUTOPLAY',
      payload: false,
    });
    this.queue.dispatch({
      type: 'SET_HEADER',
      payload: getHeaderPayload(),
    });
    this.queue.dispatch({
      type: 'CLEAR_STEERING_CHIPS',
    });
    this.internalDispatch = false;
  }

  async syncVideo() {
    // Usually only ownership changed; skip the refetch, which resets the queue
    const currentIds = this.videoIds;
    if (
      currentIds.length === this._videoList.length &&
      currentIds.every((id, i) => id === this._videoList[i].videoId)
    ) {
      this.syncQueueOwner();
      return true;
    }

    const response = await getMusicQueueRenderer(
      this._videoList.map((it) => it.videoId),
    );
    if (!response) return false;

    const items = response.queueDatas.map((it) => it.content);

    this.internalDispatch = true;
    this.queue?.dispatch({
      type: 'UPDATE_ITEMS',
      payload: {
        items: items,
        nextQueueItemId:
          this.queue.queue.store.store.getState().queue.nextQueueItemId,
        shouldAssignIds: true,
        currentIndex: -1,
      },
    });
    this.internalDispatch = false;
    setTimeout(() => {
      this.initQueue();
      this.syncQueueOwner();
    }, 0);

    return true;
  }

  syncQueueOwner() {
    const owners = this.getSnapshot();

    document.querySelectorAll('#queue').forEach((queue) => {
      queue
        .querySelectorAll<HTMLElement>(QUEUE_ENTRY_SELECTOR)
        .forEach((entry, index) => {
          const ownerId = owners[index]?.ownerId;
          if (ownerId === undefined) return; // not removed from the page yet

          // a song with a music video shows either version, label both
          const items = entry.matches(QUEUE_ITEM_TAG)
            ? [entry]
            : Array.from(entry.querySelectorAll<HTMLElement>(QUEUE_ITEM_TAG));
          items.forEach((item) => this.setItemOwner(item, ownerId, index));
        });
    });
  }

  /**
   * Keeps owner labels up to date while a session runs: YouTube Music renders
   * long queues bit by bit and can change the queue on its own, so labeling
   * only after our own changes leaves some songs without one.
   */
  watchQueueOwner() {
    this.stopWatchingQueueOwner();

    const scheduleSync = () => {
      if (this.ownerSyncFrame !== undefined) return;
      this.ownerSyncFrame = requestAnimationFrame(() => {
        this.ownerSyncFrame = undefined;
        this.syncQueueOwner();
      });
    };

    this.ownerObserver = new MutationObserver((mutations) => {
      const rendered = mutations.some((mutation) =>
        Array.from(mutation.addedNodes).some(
          (node) => !isOwnLabel(node) && containsQueueItem(node),
        ),
      );
      if (rendered) scheduleSync();
    });
    document.querySelectorAll('#queue').forEach((queue) => {
      this.ownerObserver?.observe(queue, { childList: true, subtree: true });
    });

    const store = this.queue?.queue.store.store;
    let lastItems = this.rawItems;
    const unsubscribe = store?.subscribe(() => {
      const items = this.rawItems;
      if (items === lastItems) return;
      lastItems = items;
      scheduleSync();
    });
    if (typeof unsubscribe === 'function') {
      this.unsubscribeStore = unsubscribe as () => void;
    }
  }

  private stopWatchingQueueOwner() {
    this.ownerObserver?.disconnect();
    this.ownerObserver = undefined;
    this.unsubscribeStore?.();
    this.unsubscribeStore = undefined;
    if (this.ownerSyncFrame !== undefined) {
      cancelAnimationFrame(this.ownerSyncFrame);
      this.ownerSyncFrame = undefined;
    }
  }

  private setItemOwner(item: HTMLElement, ownerId: string, index: number) {
    let data = this.getProfile(ownerId);
    const name =
      data?.name ?? t('plugins.music-together.internal.unknown-user');
    if (!data?.name && !data?.handleId) {
      data = getDefaultProfile(data?.id ?? '');
    }

    const profile =
      item.querySelector<HTMLImageElement>(`.${OWNER_CLASS}`) ??
      document.createElement('img');
    profile.classList.add(OWNER_CLASS);
    // only touch what changed, labels are refreshed often
    setAttr(profile, 'data-id', ownerId);
    setAttr(profile, 'data-index', index.toString());
    setAttr(profile, 'data-thumbnail', data.thumbnail ?? '');
    setAttr(profile, 'data-name', data.name ?? '');
    setAttr(profile, 'data-handle-id', data.handleId ?? '');
    setAttr(profile, 'src', data.thumbnail ?? '');
    setAttr(profile, 'title', data.name ?? '');
    setAttr(profile, 'alt', data.handleId ?? '');

    const label =
      item.querySelector<HTMLElement>(`.${NAME_CLASS}`) ??
      document.createElement('div');
    label.classList.add(NAME_CLASS);
    if (label.textContent !== name) label.textContent = name;

    if (!profile.isConnected) item.append(profile);
    if (!label.isConnected) item.append(label);
  }

  removeQueueOwner() {
    this.stopWatchingQueueOwner();

    const allQueue = document.querySelectorAll('#queue');

    allQueue.forEach((queue) => {
      const list = Array.from(
        queue?.querySelectorAll<HTMLElement>('ytmusic-player-queue-item') ?? [],
      );

      list.forEach((item) => {
        const profile = item.querySelector<HTMLImageElement>(
          '.music-together-owner',
        );
        const name = item.querySelector<HTMLElement>('.music-together-name');
        profile?.remove();
        name?.remove();
      });
    });
  }

  /* private */
  private broadcast(event: ConnectionEventUnion) {
    this.listeners.forEach((listener) => listener(event));
  }
}
