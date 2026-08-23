// Quick-settings front-end for quad9ctl.
//
// The toggle mirrors the manual enable/disable state: its fill tracks only
// whether a manual bypass is set, while transient conditions (bypassed by a
// network rule, proxy inactive) surface in the subtitle. The menu holds just
// the per-network bypass switch and a Settings entry; everything else lives
// in the preferences window (prefs.js). All state changes go through
// quad9ctl via pkexec; a shipped polkit rule makes that promptless for
// administrators in an active local session.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import {QuickMenuToggle, SystemIndicator} from 'resource:///org/gnome/shell/ui/quickSettings.js';

const QUAD9CTL = '/usr/bin/quad9ctl';
const STATE_DIR = '/run/quad9ctl';

function run(argv) {
    return new Promise((resolve, reject) => {
        const proc = Gio.Subprocess.new(
            argv, Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE);
        proc.communicate_utf8_async(null, null, (p, res) => {
            try {
                const [, stdout, stderr] = p.communicate_utf8_finish(res);
                if (p.get_successful())
                    resolve(stdout);
                else
                    reject(new Error(stderr.trim() || `${argv.join(' ')} failed`));
            } catch (e) {
                reject(e);
            }
        });
    });
}

const Quad9Toggle = GObject.registerClass(
class Quad9Toggle extends QuickMenuToggle {
    _init(extension) {
        const gicon = Gio.icon_new_for_string(
            `${extension.path}/icons/quad9-symbolic.svg`);

        super._init({
            title: 'Quad9 DNS',
            gicon,
            toggleMode: false,
        });

        this.menu.setHeader(gicon, 'Quad9 DNS');

        this._networkSection = new PopupMenu.PopupMenuSection();
        this.menu.addMenuItem(this._networkSection);
        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        const settingsItem = new PopupMenu.PopupMenuItem('Settings…');
        settingsItem.connect('activate', () => {
            Main.panel.closeQuickSettings();
            extension.openPreferences();
        });
        this.menu.addMenuItem(settingsItem);

        this.connect('clicked',
            () => this._runCtl([this.checked ? 'disable' : 'enable']));
        this.menu.connect('open-state-changed',
            (_menu, open) => open && this._refresh());

        // The dispatcher rewrites the bypass markers on every reconcile, so
        // watching the state directory catches quad9ctl runs from anywhere.
        this._stateMonitor = Gio.File.new_for_path(STATE_DIR)
            .monitor_directory(Gio.FileMonitorFlags.NONE, null);
        this._stateMonitor.connect('changed', () => this._scheduleRefresh(1));

        this._netMonitor = Gio.NetworkMonitor.get_default();
        this._netChangedId = this._netMonitor.connect('network-changed',
            () => this._scheduleRefresh(2));

        this._refreshTimeout = 0;
        this._destroyed = false;
        this.connect('destroy', () => {
            this._destroyed = true;
            this._stateMonitor.cancel();
            this._netMonitor.disconnect(this._netChangedId);
            if (this._refreshTimeout)
                GLib.source_remove(this._refreshTimeout);
        });

        this._refresh();
    }

    _scheduleRefresh(seconds) {
        // Debounce, and give the dispatcher a moment to finish reconciling.
        if (this._refreshTimeout)
            GLib.source_remove(this._refreshTimeout);
        this._refreshTimeout = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, seconds, () => {
            this._refreshTimeout = 0;
            this._refresh();
            return GLib.SOURCE_REMOVE;
        });
    }

    async _runCtl(args) {
        // The awaits below can outlive this actor (a pkexec auth dialog can
        // pend indefinitely while the extension is disabled), so re-check
        // _destroyed before touching any widget state.
        try {
            await run(['pkexec', QUAD9CTL, ...args]);
        } catch (e) {
            Main.notify('Quad9 DNS', e.message);
        }
        if (!this._destroyed)
            this._refresh();
    }

    async _refresh() {
        try {
            const stdout = await run([QUAD9CTL, 'status', '--json']);
            if (this._destroyed)
                return;
            this._update(JSON.parse(stdout));
        } catch (e) {
            if (!this._destroyed)
                this.subtitle = 'Status unavailable';
            console.error(`quad9 extension: ${e.message}`);
        }
    }

    _update(status) {
        this.checked = !status.manual_bypass;

        let subtitle;
        if (status.manual_bypass)
            subtitle = 'Bypassed until reboot';
        else if (status.network_bypass.length > 0)
            subtitle = `Bypassed on ${status.network_bypass.join(', ')}`;
        else if (status.proxy_active)
            subtitle = 'Active';
        else
            subtitle = 'Proxy inactive';
        this.subtitle = subtitle;
        this.menu.setHeader(this.gicon, 'Quad9 DNS', subtitle);

        this._networkSection.removeAll();
        if (status.active_connections.length === 0) {
            const item = new PopupMenu.PopupMenuItem('No active network', {reactive: false});
            this._networkSection.addMenuItem(item);
        }
        for (const conn of status.active_connections) {
            const item = new PopupMenu.PopupSwitchMenuItem(
                `Bypass on “${conn.name}”`, conn.bypass);
            item.connect('toggled', (_item, state) =>
                this._runCtl(['network', state ? 'add' : 'remove', conn.uuid]));
            this._networkSection.addMenuItem(item);
        }
    }
});

const Quad9Indicator = GObject.registerClass(
class Quad9Indicator extends SystemIndicator {
    _init(extension) {
        super._init();
        this.quickSettingsItems.push(new Quad9Toggle(extension));
    }
});

export default class Quad9Extension extends Extension {
    enable() {
        this._indicator = new Quad9Indicator(this);
        Main.panel.statusArea.quickSettings.addExternalIndicator(this._indicator);
    }

    disable() {
        this._indicator.quickSettingsItems.forEach(item => item.destroy());
        this._indicator.destroy();
        this._indicator = null;
    }
}
