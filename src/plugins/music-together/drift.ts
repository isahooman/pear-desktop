// Drift (seconds) at which a guest starts nudging its speed, and the drift at
// which it stops again (the gap avoids flapping around a single threshold)
const START_DRIFT = 0.15;
const STOP_DRIFT = 0.05;
// Speed change while catching up, small enough not to be noticeable
const NUDGE = 0.04;

const getVideo = () => document.querySelector<HTMLVideoElement>('video');

/**
 * Fixes small drift between host and guest by playing slightly faster or
 * slower, so the guest doesn't need to seek (which rebuffers and is audible).
 */
export class DriftCorrector {
  private nudged = false;

  /** `drift` is how far behind (positive) or ahead (negative) we are. */
  update(drift: number) {
    const video = getVideo();
    if (!video) return;

    // respect a playback speed picked by the user
    if (!this.nudged && video.playbackRate !== 1) return;

    const abs = Math.abs(drift);
    if (abs <= STOP_DRIFT || (!this.nudged && abs < START_DRIFT)) {
      this.reset();
      return;
    }

    this.nudged = true;
    const rate = drift > 0 ? 1 + NUDGE : 1 - NUDGE;
    if (video.playbackRate !== rate) video.playbackRate = rate;
  }

  /** Back to normal speed. Call whenever the position is set another way. */
  reset() {
    if (!this.nudged) return;
    this.nudged = false;

    const video = getVideo();
    if (video) video.playbackRate = 1;
  }
}
