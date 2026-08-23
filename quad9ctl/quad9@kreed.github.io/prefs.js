// Settings window for quad9ctl, mirroring everything the CLI exposes:
// the manual bypass, routing/proxy/resolver status, per-network bypass
// rules and per-domain ECS exceptions. Reads come from unprivileged
// 'quad9ctl status --json'; changes go through pkexec like the toggle.

import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

const QUAD9CTL = '/usr/bin/quad9ctl';

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

function actionButton(iconName, tooltip, onClicked) {
    const button = new Gtk.Button({
        icon_name: iconName,
        tooltip_text: tooltip,
        valign: Gtk.Align.CENTER,
        css_classes: ['flat'],
    });
    button.connect('clicked', onClicked);
    return button;
}

function valueRow(title) {
    const row = new Adw.ActionRow({title});
    const label = new Gtk.Label({css_classes: ['dim-label'], xalign: 1});
    row.add_suffix(label);
    row._value = label;
    return row;
}

class SettingsPage {
    constructor(window) {
        this._window = window;
        this._updating = false;
        this._networkRows = [];
        this._ecsRows = [];

        this.page = new Adw.PreferencesPage({title: 'Quad9 DNS'});

        // --- Status ---------------------------------------------------
        const status = new Adw.PreferencesGroup({title: 'Status'});
        status.set_header_suffix(
            actionButton('view-refresh-symbolic', 'Refresh', () => this.refresh()));

        this._routeSwitch = new Adw.SwitchRow({
            title: 'Route public DNS through Quad9',
            subtitle: 'Turning this off bypasses Quad9 until re-enabled or the next reboot',
        });
        this._routeSwitch.connect('notify::active', () => {
            if (!this._updating)
                this._act([this._routeSwitch.active ? 'enable' : 'disable']);
        });
        status.add(this._routeSwitch);

        this._routingRow = valueRow('Routing');
        this._proxyRow = valueRow('Proxy');
        this._resolverRow = valueRow('Resolver');
        status.add(this._routingRow);
        status.add(this._proxyRow);
        status.add(this._resolverRow);

        // --- Network bypasses ------------------------------------------
        this._networks = new Adw.PreferencesGroup({
            title: 'Network Bypasses',
            description: 'Networks whose own resolver handles public DNS while connected, ' +
                'such as a router that already forwards to Quad9',
        });
        this._networkEntry = new Adw.EntryRow({
            title: 'Add by connection name or UUID',
            show_apply_button: true,
        });
        this._networkEntry.connect('apply', () => {
            const text = this._networkEntry.text.trim();
            if (text)
                this._act(['network', 'add', text]).then(() => (this._networkEntry.text = ''));
        });
        this._networks.add(this._networkEntry);

        // --- ECS exceptions ---------------------------------------------
        this._ecs = new Adw.PreferencesGroup({
            title: 'ECS Exceptions',
            description: 'Domains resolved through Quad9’s ECS-enabled service, which ' +
                'forwards your address truncated to a /24 so latency-routed records answer ' +
                'from a nearby endpoint. Same malware blocking and DNSSEC; less subnet privacy',
        });
        this._ecsEntry = new Adw.EntryRow({
            title: 'Add domain',
            show_apply_button: true,
        });
        this._ecsEntry.connect('apply', () => {
            const text = this._ecsEntry.text.trim();
            if (text)
                this._act(['ecs', 'add', text]).then(() => (this._ecsEntry.text = ''));
        });
        this._ecs.add(this._ecsEntry);

        this.page.add(status);
        this.page.add(this._networks);
        this.page.add(this._ecs);
    }

    _toast(message) {
        try {
            this._window.add_toast(new Adw.Toast({title: message}));
        } catch (e) {
            console.error(`quad9 prefs: ${message}`);
        }
    }

    async _act(args) {
        try {
            await run(['pkexec', QUAD9CTL, ...args]);
        } catch (e) {
            this._toast(e.message);
        }
        await this.refresh();
    }

    async refresh() {
        let status;
        try {
            status = JSON.parse(await run([QUAD9CTL, 'status', '--json']));
        } catch (e) {
            this._toast(`Status unavailable: ${e.message}`);
            return;
        }

        this._updating = true;
        this._routeSwitch.active = !status.manual_bypass;
        this._updating = false;

        if (status.routing !== 'bypassed')
            this._routingRow._value.label = 'Quad9 over DoQ';
        else if (status.manual_bypass)
            this._routingRow._value.label = 'Bypassed manually';
        else if (status.network_bypass.length > 0)
            this._routingRow._value.label = `Bypassed on ${status.network_bypass.join(', ')}`;
        else
            this._routingRow._value.label = 'Bypassed';
        this._proxyRow._value.label = status.proxy_active ? 'Active' : 'Inactive';
        this._resolverRow._value.label = status.resolver_active ? 'Active' : 'Inactive';

        // Rebuild the dynamic rows: current rules, then active connections
        // that could be added, keeping the entry rows in place.
        this._networkRows.forEach(row => this._networks.remove(row));
        this._networkRows = [];
        for (const rule of status.network_rules) {
            const stale = rule.saved === false;
            const row = new Adw.ActionRow({
                title: rule.name,
                subtitle: stale ? `${rule.uuid} — connection no longer exists` : rule.uuid,
            });
            row.add_suffix(actionButton('user-trash-symbolic', 'Remove bypass',
                () => this._act(['network', 'remove', rule.uuid])));
            this._networks.add(row);
            this._networkRows.push(row);
        }
        for (const conn of status.active_connections) {
            if (conn.bypass)
                continue;
            const row = new Adw.ActionRow({title: conn.name, subtitle: 'Connected now'});
            row.add_suffix(actionButton('list-add-symbolic', 'Bypass Quad9 on this network',
                () => this._act(['network', 'add', conn.uuid])));
            this._networks.add(row);
            this._networkRows.push(row);
        }

        this._ecsRows.forEach(row => this._ecs.remove(row));
        this._ecsRows = [];
        for (const domain of status.ecs_domains) {
            const row = new Adw.ActionRow({title: domain});
            row.add_suffix(actionButton('user-trash-symbolic', 'Remove exception',
                () => this._act(['ecs', 'remove', domain])));
            this._ecs.add(row);
            this._ecsRows.push(row);
        }
    }
}

export default class Quad9Prefs extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        window.set_default_size(560, 680);
        const page = new SettingsPage(window);
        window.add(page.page);
        page.refresh();
    }
}
