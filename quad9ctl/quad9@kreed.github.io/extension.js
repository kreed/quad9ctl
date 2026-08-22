// Quick-settings front-end for quad9ctl.
//
// The toggle mirrors the manual enable/disable state: its fill tracks only
// whether a manual bypass is set, while transient conditions (bypassed by a
// network rule, proxy inactive) surface in the subtitle.  All state changes go
// through quad9ctl via pkexec; a shipped polkit rule makes that promptless for
// active local sessions.

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as ModalDialog from 'resource:///org/gnome/shell/ui/modalDialog.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import {QuickMenuToggle, SystemIndicator} from 'resource:///org/gnome/shell/ui/quickSettings.js';

const QUAD9CTL = '/usr/bin/quad9ctl';
const STATE_DIR = '/run/quad9ctl';
const ICON = 'security-high-symbolic';

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

const DomainDialog = GObject.registerClass(
class DomainDialog extends ModalDialog.ModalDialog {
    _init(onAdd) {
        super._init();

        const content = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            style: 'spacing: 12px; min-width: 22em;',
        });
        content.add_child(new St.Label({
            text: 'Route a domain through Quad9’s ECS-enabled service:',
        }));
        this._entry = new St.Entry({hint_text: 'example.com', can_focus: true});
        content.add_child(this._entry);
        this.contentLayout.add_child(content);

        const add = () => {
            const domain = this._entry.get_text().trim();
            this.close();
            if (domain)
                onAdd(domain);
        };
        this._entry.clutter_text.connect('activate', add);

        this.setButtons([
            {label: 'Cancel', action: () => this.close(), key: Clutter.KEY_Escape},
            {label: 'Add', action: add, default: true},
        ]);
        this.setInitialKeyFocus(this._entry);
    }
});

const Quad9Toggle = GObject.registerClass(
class Quad9Toggle extends QuickMenuToggle {
    _init() {
        super._init({
            title: 'Quad9 DNS',
            iconName: ICON,
            toggleMode: false,
        });

        this.menu.setHeader(ICON, 'Quad9 DNS');

        this._networkSection = new PopupMenu.PopupMenuSection();
        this.menu.addMenuItem(this._networkSection);
        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        this._ecsMenu = new PopupMenu.PopupSubMenuMenuItem('ECS carve-outs', false);
        this.menu.addMenuItem(this._ecsMenu);

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
        this.menu.setHeader(ICON, 'Quad9 DNS', subtitle);

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

        this._ecsMenu.label.text = status.ecs_domains.length > 0
            ? `ECS carve-outs (${status.ecs_domains.length})`
            : 'ECS carve-outs';
        this._ecsMenu.menu.removeAll();
        for (const domain of status.ecs_domains) {
            const item = new PopupMenu.PopupMenuItem(domain);
            item.add_child(new St.Icon({
                icon_name: 'edit-delete-symbolic',
                style_class: 'popup-menu-icon',
            }));
            item.connect('activate', () => this._runCtl(['ecs', 'remove', domain]));
            this._ecsMenu.menu.addMenuItem(item);
        }
        const addItem = new PopupMenu.PopupMenuItem('Add domain…');
        addItem.connect('activate', () => {
            Main.panel.closeQuickSettings();
            new DomainDialog(domain => this._runCtl(['ecs', 'add', domain])).open();
        });
        this._ecsMenu.menu.addMenuItem(addItem);
    }
});

const Quad9Indicator = GObject.registerClass(
class Quad9Indicator extends SystemIndicator {
    _init() {
        super._init();
        this.quickSettingsItems.push(new Quad9Toggle());
    }
});

export default class Quad9Extension extends Extension {
    enable() {
        this._indicator = new Quad9Indicator();
        Main.panel.statusArea.quickSettings.addExternalIndicator(this._indicator);
    }

    disable() {
        this._indicator.quickSettingsItems.forEach(item => item.destroy());
        this._indicator.destroy();
        this._indicator = null;
    }
}
