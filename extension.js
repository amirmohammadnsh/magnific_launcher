// SPDX-License-Identifier: GPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Gilson Fonseca

/**
 * Magnific Launcher — GNOME Shell Extension
 *
 * Adds a macOS-like magnification wave effect to dock icons on hover.
 * Compatible with Ubuntu Dock, Dash to Dock, Dash to Panel, and the default GNOME dash.
 *
 * GNOME Shell 47+
 */

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

let _settings = null;

export default class MagnificLauncher extends Extension {
    enable() {
        _settings = this.getSettings();
        this._controllers = [];

        // Delay initial attach to let the overview controls finish initializing.
        // The default GNOME dash is inside the overview and may not be interactive
        // until the overview has been shown at least once.
        this._retryTimeoutIds = new Set();
        const id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 500, () => {
            this._retryTimeoutIds.delete(id);
            this._attachToDocks();
            return GLib.SOURCE_REMOVE;
        });
        this._retryTimeoutIds.add(id);

        // If the dash was not yet ready, keep retrying.
        const delays = [1500, 3000, 5000, 8000, 12000];
        for (const delay of delays) {
            const tid = GLib.timeout_add(GLib.PRIORITY_DEFAULT, delay, () => {
                this._retryTimeoutIds.delete(tid);
                if (this._controllers.length === 0) this._attachToDocks();
                return GLib.SOURCE_REMOVE;
            });
            this._retryTimeoutIds.add(tid);
        }

        // Monitor hot-plug rebuilds monitor-dependent dash actors. Re-discover
        // them after Mutter and other extensions have finished their relayout.
        this._reattachTimeoutId = null;
        this._reattachFull = false;
        this._monitorsChangedId = Main.layoutManager.connect('monitors-changed',
            () => this._scheduleReattach(true));

        // Re-attach when the overview opens/closes (the dash becomes
        // interactive when the overview shows for the first time).
        this._overviewHiddenId = Main.overview.connect('hidden', () => {
            this._detachAll();
            this._attachToDocks();
        });

        this._overviewShowingId = Main.overview.connect('showing', () => {
            this._detachAll();
            this._attachToDocks();
        });
    }

    disable() {
        if (this._monitorsChangedId) {
            Main.layoutManager.disconnect(this._monitorsChangedId);
            this._monitorsChangedId = null;
        }
        if (this._reattachTimeoutId !== null) {
            GLib.source_remove(this._reattachTimeoutId);
            this._reattachTimeoutId = null;
        }
        if (this._overviewHiddenId) {
            Main.overview.disconnect(this._overviewHiddenId);
            this._overviewHiddenId = null;
        }
        if (this._overviewShowingId) {
            Main.overview.disconnect(this._overviewShowingId);
            this._overviewShowingId = null;
        }
        for (const id of this._retryTimeoutIds ?? []) {
            GLib.source_remove(id);
        }
        this._retryTimeoutIds?.clear();
        this._detachAll();
        _settings = null;
    }

    _attachToDocks() {
        const docks = _findDashContainers();
        for (const {eventActor, iconsActor, showAppsIcon} of docks) {
            if (!eventActor || this._controllers.some(c => c.eventActor === eventActor)) continue;
            const ctrl = new DockMagnifier(eventActor, iconsActor, showAppsIcon,
                c => this._onControllerDestroyed(c));
            ctrl.attach();
            this._controllers.push(ctrl);
        }
        if (this._controllers.length > 0) {
            log(`[MagnificLauncher] Attached to ${this._controllers.length} dock(s)`);
        }
    }

    _detachAll() {
        for (const ctrl of this._controllers) {
            ctrl.detach();
        }
        this._controllers = [];
    }

    /**
     * A dock destroyed its actors (e.g. Ubuntu Dock / Dash to Dock recreate
     * their docks when some of their settings change). Drop the dead
     * controller and re-discover the replacement dock.
     */
    _onControllerDestroyed(ctrl) {
        this._controllers = this._controllers.filter(c => c !== ctrl);
        this._scheduleReattach(false);
    }

    /**
     * Debounced re-discovery. With `full`, every controller is detached first
     * (monitor changes); otherwise only missing docks are attached.
     */
    _scheduleReattach(full) {
        this._reattachFull ||= full;
        if (this._reattachTimeoutId !== null)
            GLib.source_remove(this._reattachTimeoutId);

        this._reattachTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 500, () => {
            this._reattachTimeoutId = null;
            if (this._reattachFull)
                this._detachAll();
            this._reattachFull = false;
            this._attachToDocks();
            return GLib.SOURCE_REMOVE;
        });
    }
}

// ─── Dock discovery ───────────────────────────────────────────────────────────

/**
 * Detects all active docks and returns an array of descriptors:
 *   { eventActor, iconsActor, showAppsIcon }
 *
 * Detection order:
 *  1. Ubuntu Dock / Dash to Dock — via _trackedActors (chrome actors)
 *  2. Dash to Dock — via extensionManager.lookup()
 *  3. Dash to Panel — via extensionManager.lookup()
 *  4. Default GNOME dash — via Main.overview._overview._controls.dash
 *
 * Ubuntu Dock / Dash to Dock layout:
 *
 *   DockedDash (chrome, St.Widget)
 *    └── _slider (DashSlideContainer)
 *          └── _box  (St.BoxLayout, reactive:true)  ← eventActor
 *                └── dash (DockDash, St.Widget)
 *                      ├── _dashContainer
 *                      │     ├── _scrollView → _boxContainer
 *                      │     │     └── _box (St.BoxLayout)  ← iconsActor
 *                      │     └── _showAppsIcon
 *                      └── _showAppsIcon
 *
 * Default GNOME dash layout:
 *
 *   Dash (St.Widget, name="dash")
 *     ├── _showAppsIcon (ShowAppsIcon)
 *     ├── _box (St.BoxLayout)  ← iconsActor
 *     └── _background
 */
function _findDashContainers() {
    const results = [];

    function _pushFromDockedDashes(docks) {
        for (const dock of docks) {
            const eventActor = dock._box;
            const iconsActor = dock.dash?._box;
            const showAppsIcon = dock.dash?._showAppsIcon ?? null;
            if (eventActor && iconsActor) results.push({eventActor, iconsActor, showAppsIcon});
        }
    }

    // ── 1. Ubuntu Dock / Dash to Dock — scan chrome actors ────────────────
    try {
        const tracked = Main.layoutManager?._trackedActors ?? [];
        const dockedDashes = tracked
            .map(e => e.actor)
            .filter(a => a?._box && a?.dash?._box);
        _pushFromDockedDashes(dockedDashes);
    } catch (_) { /* layout not ready */ }

    // ── 2. Dash to Dock — extension API ───────────────────────────────────
    if (results.length === 0) {
        try {
            const dtd = Main.extensionManager?.lookup('dash-to-dock@micxgx.gmail.com');
            if (dtd) {
                const docks = dtd.stateObj?.dockManager?._allDocks
                    ?? dtd.stateObj?.dockManager?.docks ?? [];
                _pushFromDockedDashes(docks);
            }
        } catch (_) { /* extension not present */ }
    }

    // ── 3. Dash to Panel ──────────────────────────────────────────────────
    if (results.length === 0) {
        try {
            const dtp = Main.extensionManager?.lookup('dash-to-panel@jderose9.github.com');
            if (dtp) {
                const panels = dtp.stateObj?.taskbarManager?._panels ?? [];
                for (const p of panels) {
                    const box = p.taskbar?._box ?? p.taskbar?.actor;
                    if (box) results.push({eventActor: box, iconsActor: box});
                }
            }
        } catch (_) { /* extension not present */ }
    }

    // ── 4. Default GNOME dash ─────────────────────────────────────────────
    if (results.length === 0) {
        try {
            const dash = Main.overview?._overview?._controls?.dash;
            if (dash) {
                const iconsActor = dash._box ?? dash;
                const showAppsIcon = dash._showAppsIcon ?? null;
                // Use the Dash widget itself as eventActor — it is reactive
                // and receives pointer events both in the overview and on the
                // desktop when shown by extensions like Just Perfection.
                results.push({eventActor: dash, iconsActor, showAppsIcon});
            }
        } catch (_) { /* overview not ready */ }
    }

    return results;
}

// ─── Per-dock magnifier controller ───────────────────────────────────────────

class DockMagnifier {
    /**
     * @param {Clutter.Actor} eventActor   Reactive actor that receives pointer events.
     * @param {Clutter.Actor} iconsActor   Actor whose direct children are the icon buttons.
     * @param {Clutter.Actor|null} showAppsIcon  Show Applications button.
     * @param {Function|null} onDestroyed  Called when the dock actors are destroyed.
     */
    constructor(eventActor, iconsActor, showAppsIcon = null, onDestroyed = null) {
        this.eventActor = eventActor;
        this._iconsActor = iconsActor ?? eventActor;
        this._showAppsIcon = showAppsIcon;
        this._onDestroyed = onDestroyed;
        this._destroyed = false;

        this._icons = [];
        // The cache is rebuilt lazily on pointer events: icons added by the
        // dock start at zero size (GNOME's DashItemContainer entrance
        // animation), so a snapshot taken on child-added would miss them.
        this._cacheDirty = true;
        this._hoveredIndex = -1;
        this._restoreTimeoutId = null;
        this._signalIds = [];
    }

    // ── Lifecycle ──────────────────────────────────────────────────────────────

    attach() {
        if (!_isActorAlive(this.eventActor)) return;

        this._refreshIconCache();

        try {
            this._connect(this.eventActor, 'destroy', this._onActorDestroyed.bind(this));
            if (this._iconsActor !== this.eventActor)
                this._connect(this._iconsActor, 'destroy', this._onActorDestroyed.bind(this));
            this._connect(this.eventActor, 'enter-event', this._onEnter.bind(this));
            this._connect(this.eventActor, 'leave-event', this._onLeave.bind(this));
            this._connect(this.eventActor, 'motion-event', this._onMotion.bind(this));
        } catch (e) {
            logError(e, '[MagnificLauncher] Failed to connect pointer events');
            return;
        }

        for (const sig of ['child-added', 'child-removed']) {
            try {
                this._connect(this._iconsActor, sig, () => (this._cacheDirty = true));
            } catch (_) {}
        }
    }

    _connect(actor, signal, handler) {
        const id = actor.connect(signal, handler);
        this._signalIds.push({actor, id});
        return id;
    }

    detach() {
        this._cancelRestoreTimeout();
        this._restoreAllImmediate();

        for (const {actor, id} of this._signalIds) {
            if (_isActorAlive(actor)) {
                try { actor.disconnect(id); } catch (_) {}
            }
        }
        this._signalIds = [];
        this._icons = [];
        this._hoveredIndex = -1;
    }

    _onActorDestroyed() {
        if (this._destroyed) return;
        this._destroyed = true;
        this._cancelRestoreTimeout();
        // Disconnect from whichever actors are still alive (the icons actor
        // may outlive the event actor, or vice versa).
        for (const {actor, id} of this._signalIds) {
            if (_isActorAlive(actor)) {
                try { actor.disconnect(id); } catch (_) {}
            }
        }
        this._signalIds = [];
        this._icons = [];
        this._hoveredIndex = -1;
        this._onDestroyed?.(this);
    }

    // ── Icon cache ─────────────────────────────────────────────────────────────

    /**
     * Rebuilds the icon cache if it is stale. Returns true when the set of
     * cached icons changed.
     */
    _ensureIconCache() {
        if (!this._cacheDirty) return false;
        return this._refreshIconCache();
    }

    _refreshIconCache() {
        if (!_isActorAlive(this._iconsActor)) return false;
        const MIN_ICON_SIZE = 16;
        // Set when a real icon is skipped only because it is still animating
        // in (or not allocated yet): keep the cache dirty so it is picked up
        // on a later motion event.
        let pending = false;
        const icons = this._iconsActor.get_children().filter(child => {
            if (!child.visible) return false;
            const cls = (child.style_class || '').toLowerCase();
            const name = (child.get_name() || '').toLowerCase();
            if (cls.includes('separator') || cls.includes('spacer') ||
                name.includes('separator') || name.includes('spacer')) {
                return false;
            }
            if (child.animatingOut) return false;
            if (!_isIconSettled(child)) {
                pending = true;
                return false;
            }
            const w = child.get_width();
            const h = child.get_height();
            if (w < MIN_ICON_SIZE || h < MIN_ICON_SIZE) {
                pending = true;
                return false;
            }
            return true;
        });

        const changed = icons.length !== this._icons.length ||
            icons.some((icon, i) => icon !== this._icons[i]);
        this._icons = icons;
        this._cacheDirty = pending;
        return changed;
    }

    // ── Coordinate helpers ─────────────────────────────────────────────────────

    _getIconCenterInIconsActorSpace(icon) {
        const parent = icon.get_parent();
        if (!parent) return null;
        if (parent === this._iconsActor) {
            const box = icon.get_allocation_box();
            return [(box.x1 + box.x2) / 2, (box.y1 + box.y2) / 2];
        }
        const parentBox = parent.get_allocation_box();
        return [(parentBox.x1 + parentBox.x2) / 2, (parentBox.y1 + parentBox.y2) / 2];
    }

    /** Returns the Show Apps button centre as [x, y] in iconsActor space. */
    _getShowAppsCenterInIconsActorSpace() {
        if (!this._showAppsIcon || !_isActorAlive(this._showAppsIcon)) return null;
        const [sx, sy] = this._showAppsIcon.get_transformed_position();
        const box = this._showAppsIcon.get_allocation_box();
        const stageCX = sx + (box.x2 - box.x1) / 2;
        const stageCY = sy + (box.y2 - box.y1) / 2;
        const [ok, localX, localY] = this._iconsActor.transform_stage_point(stageCX, stageCY);
        return ok ? [localX, localY] : null;
    }

    /**
     * True when the icons are laid out top-to-bottom (dock on the left or
     * right). All distances along the dock use this axis.
     */
    _isVertical() {
        const actor = this._iconsActor;
        try {
            const orientation = actor.orientation ?? actor.layout_manager?.orientation;
            if (orientation !== undefined && orientation !== null)
                return orientation === Clutter.Orientation.VERTICAL;
            return Boolean(actor.vertical);
        } catch (_) {
            return false;
        }
    }

    // ── Event handlers ─────────────────────────────────────────────────────────

    _onEnter(_actor, _event) {
        this._cancelRestoreTimeout();
        // Re-validate on every entry: catches visibility/size changes that do
        // not emit child-added/child-removed.
        this._cacheDirty = true;
    }

    _onLeave(_actor, _event) {
        this._scheduleRestore();
    }

    _onMotion(_actor, event) {
        // Indices into _icons are invalidated when the cache changes, so the
        // magnification must be re-applied even if the index is the same.
        const cacheChanged = this._ensureIconCache();
        if (this._icons.length === 0) return;

        const [pointerX, pointerY] = event.get_coords();
        const newIndex = this._iconIndexAtPointer(pointerX, pointerY);

        if (!cacheChanged && newIndex === this._hoveredIndex) return;

        this._hoveredIndex = newIndex;

        if (newIndex === -1) {
            this._scheduleRestore();
        } else {
            this._cancelRestoreTimeout();
            this._applyMagnification(newIndex);
        }
    }

    // ── Hit-testing ────────────────────────────────────────────────────────────

    _iconIndexAtPointer(stageX, stageY) {
        if (this._icons.length === 0 && !this._showAppsIcon) return -1;

        const [ok, actorLocalX, actorLocalY] =
            this._iconsActor.transform_stage_point(stageX, stageY);
        if (!ok) return -1;

        let bestIndex = -1;
        let bestDist = Infinity;

        for (let i = 0; i < this._icons.length; i++) {
            const icon = this._icons[i];
            if (!_isActorAlive(icon) || !icon.visible || !_isIconSettled(icon)) continue;

            const center = this._getIconCenterInIconsActorSpace(icon);
            if (!center) continue;

            const dist = Math.hypot(actorLocalX - center[0], actorLocalY - center[1]);
            if (dist < bestDist) {
                bestDist = dist;
                bestIndex = i;
            }
        }

        const showAppsCenter = this._getShowAppsCenterInIconsActorSpace();
        if (showAppsCenter !== null) {
            // Position along the dock comes from the button itself; the
            // cross-axis position is aligned with the icons (the button may
            // live in a different container).
            const firstCenter = this._icons.length > 0
                ? this._getIconCenterInIconsActorSpace(this._icons[0])
                : null;
            let [showAppsX, showAppsY] = showAppsCenter;
            if (this._isVertical())
                showAppsX = firstCenter ? firstCenter[0] : actorLocalX;
            else
                showAppsY = firstCenter ? firstCenter[1] : actorLocalY;
            const dist = Math.hypot(actorLocalX - showAppsX, actorLocalY - showAppsY);
            if (dist < bestDist) {
                bestDist = dist;
                bestIndex = this._icons.length;
            }
        }

        const referenceSize = this._getIconNominalSize();
        const PROXIMITY_PX = referenceSize * 0.75;
        return bestDist <= PROXIMITY_PX ? bestIndex : -1;
    }

    _getIconNominalSize() {
        // Measure along the dock: across it, slots stretch to the dock size.
        const vertical = this._isVertical();
        let totalW = 0;
        let count = 0;
        for (const icon of this._icons) {
            if (!_isActorAlive(icon) || !_isIconSettled(icon)) continue;
            const box = icon.get_allocation_box();
            const w = vertical ? box.y2 - box.y1 : box.x2 - box.x1;
            if (w > 0) { totalW += w; count++; }
        }
        return count > 0 ? totalW / count : 48;
    }

    // ── Scale application ──────────────────────────────────────────────────────

    _applyMagnification(hoveredIdx) {
        const zoomPx = _settings?.get_int('zoom-pixels') ?? 8;
        const STEP = _settings?.get_double('neighbour-step') ?? 0.10;

        const iconSize = this._getIconNominalSize();
        const hoveredScale = (iconSize + zoomPx) / iconSize;

        // Distances are measured along the dock axis (x for a horizontal
        // dock, y for a vertical one).
        const axis = this._isVertical() ? 1 : 0;
        const isShowAppsHovered = hoveredIdx >= this._icons.length;
        let hoveredPos;
        if (isShowAppsHovered) {
            const showAppsCenter = this._getShowAppsCenterInIconsActorSpace();
            if (showAppsCenter === null) return;
            hoveredPos = showAppsCenter[axis];
        } else {
            const center = this._getIconCenterInIconsActorSpace(this._icons[hoveredIdx]);
            if (!center) return;
            hoveredPos = center[axis];
        }

        for (let i = 0; i < this._icons.length; i++) {
            const icon = this._icons[i];
            if (!_isActorAlive(icon)) continue;

            const center = this._getIconCenterInIconsActorSpace(icon);
            if (!center) continue;

            const pixelDist = Math.abs(center[axis] - hoveredPos);
            const ringDist = pixelDist / iconSize;

            const targetScale = i === hoveredIdx
                ? hoveredScale
                : Math.max(1.0, Math.round((hoveredScale - ringDist * STEP) * 100) / 100);
            _animateIconScale(icon, targetScale, hoveredScale);
        }

        if (this._showAppsIcon && _isActorAlive(this._showAppsIcon)) {
            const showAppsCenter = this._getShowAppsCenterInIconsActorSpace();
            if (showAppsCenter !== null) {
                const pixelDist = Math.abs(showAppsCenter[axis] - hoveredPos);
                const ringDist = pixelDist / iconSize;
                const targetScale = isShowAppsHovered
                    ? hoveredScale
                    : Math.max(1.0, Math.round((hoveredScale - ringDist * STEP) * 100) / 100);
                _animateIconScale(this._showAppsIcon, targetScale, hoveredScale);
            }
        }
    }

    // ── Restore ────────────────────────────────────────────────────────────────

    _scheduleRestore() {
        this._cancelRestoreTimeout();
        const delay = _settings?.get_int('restore-delay') ?? 40;
        this._restoreTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, delay, () => {
            this._hoveredIndex = -1;
            this._restoreAll();
            this._restoreTimeoutId = null;
            return GLib.SOURCE_REMOVE;
        });
    }

    _cancelRestoreTimeout() {
        if (this._restoreTimeoutId !== null) {
            GLib.source_remove(this._restoreTimeoutId);
            this._restoreTimeoutId = null;
        }
    }

    _restoreAll() {
        for (const icon of this._icons) {
            if (_isActorAlive(icon)) _animateIconScale(icon, 1.0, 1.0);
        }
        if (this._showAppsIcon && _isActorAlive(this._showAppsIcon))
            _animateIconScale(this._showAppsIcon, 1.0, 1.0);
    }

    _restoreAllImmediate() {
        for (const icon of this._icons)
            _resetIconScaleImmediate(icon);
        _resetIconScaleImmediate(this._showAppsIcon);
    }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function _isActorAlive(actor) {
    if (actor == null) return false;
    try {
        void actor.visible;
        return true;
    } catch (_) {
        return false;
    }
}

/**
 * GNOME's DashItemContainer animates scale_x/scale_y (and opacity) when an
 * icon enters (0 → 1) or leaves (1 → 0, then destroy). The magnifier must
 * not touch the scale while such an animation runs: easing scale would
 * replace GNOME's transition (cutting the entrance short, or cancelling the
 * exit transition whose completion destroys the item).
 */
function _isIconSettled(actor) {
    try {
        if (actor.animatingOut) return false;
        if (actor.get_transition('opacity')) return false;
        return actor.scale_x >= 0.999 && actor.scale_y >= 0.999;
    } catch (_) {
        return false;
    }
}

/** Removes only the magnifier's own scaling; leaves GNOME's animations alone. */
function _resetIconScaleImmediate(actor) {
    if (!actor || !_isActorAlive(actor) || !_isIconSettled(actor)) return;
    try {
        actor.remove_transition('scale-x');
        actor.remove_transition('scale-y');
        actor.set_scale(1.0, 1.0);
    } catch (_) {}
}

function _animateIconScale(actor, scale, maxScale = 4.0) {
    if (!_isActorAlive(actor) || !_isIconSettled(actor)) return;

    const duration = _settings?.get_int('anim-duration') ?? 120;
    const clamped = Math.max(1.0, Math.min(maxScale, scale));

    if (Math.abs(actor.scale_x - clamped) < 0.001) return;

    try {
        actor.set_pivot_point(0.5, 0.5);

        if (clamped > 1.0) {
            const sharp = _settings?.get_boolean('sharp-scaling') ?? false;
            actor.magnification_filter = sharp
                ? Clutter.ScalingFilter.NEAREST
                : Clutter.ScalingFilter.LINEAR;
            actor.offscreen_redirect = Clutter.OffscreenRedirect.NEVER;
        } else {
            actor.offscreen_redirect = Clutter.OffscreenRedirect.AUTOMATIC;
        }

        actor.ease({
            scale_x: clamped,
            scale_y: clamped,
            duration,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        });
    } catch (_) {}
}
