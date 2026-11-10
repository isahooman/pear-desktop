import type { VideoData } from '../types';
import type {
  ItemPlaylistPanelVideoRenderer,
  PlaylistPanelVideoWrapperRenderer,
  QueueItem,
} from '@/types/datahost-get-state';

export const mapQueueItem = <T>(
  map: (item?: ItemPlaylistPanelVideoRenderer) => T,
  array: QueueItem[],
): T[] =>
  array
    .map((item) => {
      if ('playlistPanelVideoWrapperRenderer' in item) {
        const keys = Object.keys(
          item.playlistPanelVideoWrapperRenderer!.primaryRenderer,
        ) as (keyof PlaylistPanelVideoWrapperRenderer['primaryRenderer'])[];
        return item.playlistPanelVideoWrapperRenderer!.primaryRenderer[keys[0]];
      }
      if ('playlistPanelVideoRenderer' in item) {
        return item.playlistPanelVideoRenderer;
      }

      console.error('Music Together: Unknown item', item);
      return undefined;
    })
    .map(map);

/**
 * Every video id a queue item can play: the song, plus its music video (or
 * the other way around). The first id is the one shown in the queue.
 */
export const getItemVideoIds = (item: QueueItem): string[] => {
  const primary = mapQueueItem((it) => it?.videoId, [item])[0];
  const counterparts =
    item.playlistPanelVideoWrapperRenderer?.counterpart?.map(
      (it) => it?.counterpartRenderer?.playlistPanelVideoRenderer?.videoId,
    ) ?? [];
  return [primary, ...counterparts].filter((id): id is string => !!id);
};

/**
 * Pairs each queue item (given as its video ids) with its entry in `known`.
 * Entries are matched by video id rather than position, so a song keeps its
 * owner however the rest of the queue changes. Items with no entry get
 * `fallbackOwner`.
 */
export const alignOwners = (
  items: string[][],
  known: VideoData[],
  fallbackOwner: string,
): VideoData[] => {
  // entries for each video id, in queue order, so duplicates keep their order
  const byId = new Map<string, VideoData[]>();
  known.forEach((it) => {
    const entries = byId.get(it.videoId);
    if (entries) entries.push(it);
    else byId.set(it.videoId, [it]);
  });

  return items.map((ids) => {
    let match: VideoData | undefined;
    for (const id of ids) {
      match = byId.get(id)?.shift();
      if (match) break;
    }
    return {
      videoId: ids[0] ?? '',
      ownerId: match?.ownerId ?? fallbackOwner,
    };
  });
};

/** Cheap FNV-1a fingerprint of the queue order, used to detect desync. */
export const hashVideoIds = (videoIds: string[]) => {
  let hash = 0x811c9dc5;
  for (const id of videoIds) {
    for (let i = 0; i < id.length; i++) {
      hash ^= id.charCodeAt(i);
      hash = Math.imul(hash, 0x01000193);
    }
    hash ^= 0x2c; // separator
    hash = Math.imul(hash, 0x01000193);
  }
  return `${videoIds.length}:${(hash >>> 0).toString(16)}`;
};
