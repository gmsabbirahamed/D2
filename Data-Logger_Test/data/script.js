let config = null;
let dirty = false;

// Which sensors/channels are collapsed. Keyed by sensor.id / channel.id.
const collapsedSensors  = new Set();
const collapsedChannels = new Set();

const $ = (id) => document.getElementById(id);

function setStatus(text, ok = true) {
    $("statusText").textContent = text;
    $("statusDot").style.background = ok ? "#22c55e" : "#ef4444";
}

function setDirty(v) {
    dirty = v;
    const el = $("dirtyIndicator");
    el.classList.toggle("dirty", v);
    el.textContent = v ? "Unsaved changes" : "No unsaved changes";
}

function switchTab(name) {
    document.querySelectorAll(".tab").forEach(t =>
        t.classList.toggle("active", t.dataset.tab === name));
    document.querySelectorAll(".tab-panel").forEach(p =>
        p.classList.toggle("active", p.id === "tab-" + name));
}

// ---------- Load ----------

async function loadConfig() {
    try {
        setStatus("Loading...", true);
        const r = await fetch("/api/config");
        if (!r.ok) throw new Error("HTTP " + r.status);
        config = await r.json();

        config.device  = config.device  || {};
        config.network = config.network || {};
        config.sensors = config.sensors || [];

        // Auto-expand the first sensor if there is one, collapse the rest
        collapsedSensors.clear();
        collapsedChannels.clear();
        config.sensors.forEach((s, i) => {
            if (i > 0) collapsedSensors.add(sensorKey(s, i));
            (s.channels || []).forEach((c, ci) => {
                if (ci > 0) collapsedChannels.add(channelKey(s, i, c, ci));
            });
        });

        render();
        setDirty(false);
        setStatus("Connected", true);
    } catch (e) {
        console.error(e);
        setStatus("Connection error", false);
        alert("Could not load configuration.");
    }
}

// ---------- Identity keys (survive re-render) ----------

function sensorKey(s, i)  { return `s:${s.id ?? i}`; }
function channelKey(s, si, c, ci) { return `s:${s.id ?? si}:c:${c.id ?? ci}`; }

// ---------- Render ----------

function render() {
    if (!config) return;

    $("deviceId").value   = config.device.id || "";
    $("deviceName").value = config.device.name || "";
    $("deviceSubtitle").textContent =
        config.device.name ? config.device.name : "Device configuration";

    const n = config.network;
    $("apn").value        = n.apn        || "";
    $("apnUser").value    = n.apn_user   || "";
    $("apnPass").value    = n.apn_pass   || "";
    $("broker").value     = n.broker     || "";
    $("brokerPort").value = n.broker_port ?? 1883;
    $("mqttUser").value   = n.mqtt_user  || "";
    $("mqttPass").value   = n.mqtt_pass  || "";
    $("pubTopic").value   = n.pub_topic  || "";
    $("subTopic").value   = n.sub_topic  || "";
    $("ackTopic").value   = n.ack_topic  || "";

    renderSensors();
    updateSensorBadge();
}

function updateSensorBadge() {
    const n = (config.sensors || []).length;
    $("tabSensorBadge").textContent = n;
    $("sensorCount").textContent = `${n} / 12 sensors configured`;
}

function renderSensors() {
    const container = $("sensors");
    container.innerHTML = "";

    const sensors = config.sensors || [];

    if (sensors.length === 0) {
        container.innerHTML = `
            <div class="empty">
                <strong>No sensors configured</strong>
                Click <em>+ Add Sensor</em> to create your first Modbus RTU sensor.
            </div>`;
        return;
    }

    sensors.forEach((sensor, si) => {
        container.appendChild(buildSensorCard(sensor, si));
    });
}

function buildSensorCard(sensor, si) {
    const key = sensorKey(sensor, si);
    const isCollapsed = collapsedSensors.has(key);

    const div = document.createElement("div");
    div.className = "sensor" + (isCollapsed ? " collapsed" : "");
    div.dataset.sensorKey = key;

    const channels = sensor.channels || [];

    div.innerHTML = `
        <div class="sensor-head" onclick="toggleSensor('${key}')">
            <div class="sensor-head-left">
                <span class="sensor-toggle">▶</span>
                <span class="sensor-num">S${sensor.id ?? si + 1}</span>
                <div style="min-width:0;">
                    <div class="sensor-title">${esc(sensor.name || "Unnamed sensor")}</div>
                    <div class="sensor-meta">
                        <span class="pill pill-info">Slave ${sensor.slave_id ?? 1}</span>
                        <span class="pill pill-info">${sensor.baud ?? 9600} 8${(sensor.parity || "N")[0]}${sensor.stop_bits ?? 1}</span>
                        <span class="pill pill-info">${channels.length} ch</span>
                    </div>
                </div>
            </div>

            <div class="sensor-head-right" onclick="event.stopPropagation()">
                <button class="icon-btn danger"
                    title="Delete sensor"
                    onclick="deleteSensor(${si})">✕ Delete</button>
            </div>
        </div>

        <div class="sensor-body" ${isCollapsed ? 'style="display:none"' : ""}>
            ${sensorBody(sensor, si)}
        </div>
    `;

    return div;
}

function sensorBody(sensor, si) {
    return `
        <div class="group">
            <div class="group-title">Identity</div>
            <div class="grid">
                <label class="field">
                    <span class="field-label">Sensor ID</span>
                    <input type="number" min="1"
                        value="${sensor.id ?? si + 1}"
                        oninput="setSensor(${si}, 'id', Number(this.value))">
                </label>
                <label class="field">
                    <span class="field-label">Sensor Name</span>
                    <input value="${esc(sensor.name || '')}"
                        placeholder="e.g. Weather Station"
                        oninput="setSensor(${si}, 'name', this.value)">
                </label>
            </div>
        </div>

        <div class="group">
            <div class="group-title">Modbus RTU — Serial</div>
            <div class="grid cols-3">
                <label class="field">
                    <span class="field-label">Slave ID</span>
                    <input type="number" min="0" max="255"
                        value="${sensor.slave_id ?? 1}"
                        oninput="setSensor(${si}, 'slave_id', Number(this.value))">
                </label>
                <label class="field">
                    <span class="field-label">Baudrate</span>
                    <select onchange="setSensor(${si}, 'baud', Number(this.value))">
                        ${baudOptions(sensor.baud)}
                    </select>
                </label>
                <label class="field">
                    <span class="field-label">Parity</span>
                    <select onchange="setSensor(${si}, 'parity', this.value)">
                        ${enumOptions(["NONE","EVEN","ODD"], sensor.parity || "NONE")}
                    </select>
                </label>
                <label class="field">
                    <span class="field-label">Data Bits</span>
                    <select onchange="setSensor(${si}, 'data_bits', Number(this.value))">
                        ${numOptions([7,8], sensor.data_bits ?? 8)}
                    </select>
                </label>
                <label class="field">
                    <span class="field-label">Stop Bits</span>
                    <select onchange="setSensor(${si}, 'stop_bits', Number(this.value))">
                        ${numOptions([1,2], sensor.stop_bits ?? 1)}
                    </select>
                </label>
            </div>
        </div>

        <div class="group">
            <div class="group-title">Timing &amp; Reliability</div>
            <div class="grid">
                <label class="field">
                    <span class="field-label">Retry Attempts</span>
                    <input type="number" min="0" max="10"
                        value="${sensor.retry_attempts ?? 3}"
                        oninput="setSensor(${si}, 'retry_attempts', Number(this.value))">
                    <small class="field-help">Number of retries on a failed read.</small>
                </label>
                <label class="field">
                    <span class="field-label">Receive Timeout (ms)</span>
                    <input type="number" min="100" step="50"
                        value="${sensor.recv_timeout_ms ?? 1000}"
                        oninput="setSensor(${si}, 'recv_timeout_ms', Number(this.value))">
                    <small class="field-help">Time to wait for a reply before retrying.</small>
                </label>
            </div>
        </div>

        ${channelsSection(sensor, si)}
    `;
}

function channelsSection(sensor, si) {
    const channels = sensor.channels || [];
    const canAdd = channels.length < 12;

    return `
        <div class="channels-header">
            <strong>Channels (${channels.length} / 12)</strong>
            <button onclick="addChannel(${si})" ${canAdd ? "" : "disabled"}>
                + Add Channel
            </button>
        </div>
        <div id="channels-${si}">
            ${
                channels.length === 0
                    ? `<div class="empty" style="padding:20px;">
                           No channels. Add one to start reading registers.
                       </div>`
                    : channels.map((c, ci) => channelHtml(sensor, si, c, ci)).join("")
            }
        </div>
    `;
}

function channelHtml(sensor, si, ch, ci) {
    const key = channelKey(sensor, si, ch, ci);
    const isCollapsed = collapsedChannels.has(key);

    const meta =
        `${ch.register_type || "HOLDING"} @ ${ch.register_number || "0x0000"}` +
        ` · ${ch.data_type || "INT16"}` +
        ` × ${ch.scale_factor ?? 1}`;

    return `
        <div class="channel${isCollapsed ? " collapsed" : ""}" data-channel-key="${key}">
            <div class="channel-head" onclick="toggleChannel('${key}')">
                <div class="channel-head-left">
                    <span class="channel-num">C${ch.id ?? ci + 1}</span>
                    <div style="min-width:0;">
                        <div class="channel-alias">${esc(ch.alias || "Unnamed channel")}</div>
                        <div class="channel-meta">${esc(meta)}</div>
                    </div>
                </div>
                <div onclick="event.stopPropagation()">
                    <button class="icon-btn danger"
                        title="Delete channel"
                        onclick="deleteChannel(${si}, ${ci})">✕</button>
                </div>
            </div>

            <div class="channel-body" ${isCollapsed ? 'style="display:none"' : ""}>
                <div class="channel-grid">
                    <label class="field">
                        <span class="field-label">Channel ID</span>
                        <input type="number" min="1"
                            value="${ch.id ?? ci + 1}"
                            oninput="setChannel(${si}, ${ci}, 'id', Number(this.value))">
                    </label>
                    <label class="field">
                        <span class="field-label">Alias</span>
                        <input value="${esc(ch.alias || '')}"
                            placeholder="e.g. Temperature"
                            oninput="setChannel(${si}, ${ci}, 'alias', this.value)">
                    </label>
                    <label class="field">
                        <span class="field-label">Register Type</span>
                        <select onchange="setChannel(${si}, ${ci}, 'register_type', this.value)">
                            ${enumOptions(
                                ["HOLDING","INPUT","COIL","DISCRETE"],
                                ch.register_type || "HOLDING")}
                        </select>
                    </label>

                    <label class="field">
                        <span class="field-label">Register Number (hex)</span>
                        <input value="${esc(ch.register_number || '0x0000')}"
                            placeholder="0x0001"
                            style="font-family:monospace;"
                            oninput="setChannel(${si}, ${ci}, 'register_number', this.value)">
                        <small class="field-help">e.g. 0x0000, 0x03E8</small>
                    </label>
                    <label class="field">
                        <span class="field-label">Scale Factor</span>
                        <input type="number" step="any"
                            value="${ch.scale_factor ?? 1}"
                            oninput="setChannel(${si}, ${ci}, 'scale_factor', Number(this.value))">
                    </label>
                    <label class="field">
                        <span class="field-label">Value Type</span>
                        <select onchange="setChannel(${si}, ${ci}, 'value_type', this.value)">
                            ${enumOptions(["ABSOLUTE","DELTA"],
                                ch.value_type || "ABSOLUTE")}
                        </select>
                    </label>

                    <label class="field">
                        <span class="field-label">Data Type</span>
                        <select onchange="setChannel(${si}, ${ci}, 'data_type', this.value)">
                            ${enumOptions(
                                ["UINT16","INT16","UINT32","INT32",
                                 "UINT64","INT64","FLOAT32","FLOAT64"],
                                ch.data_type || "INT16")}
                        </select>
                    </label>
                    <label class="field">
                        <span class="field-label">Register Width</span>
                        <select onchange="setChannel(${si}, ${ci}, 'register_width', Number(this.value))">
                            ${numOptions([1,2,4], ch.register_width ?? 1)}
                        </select>
                    </label>
                    <label class="field">
                        <span class="field-label">Bit Index</span>
                        <input type="number" min="-1" max="63"
                            value="${ch.bit_index ?? -1}"
                            oninput="setChannel(${si}, ${ci}, 'bit_index', Number(this.value))">
                        <small class="field-help">-1 = use entire register.</small>
                    </label>

                    <label class="field field-wide">
                        <span class="field-label">Byte Order</span>
                        <select onchange="setChannel(${si}, ${ci}, 'byte_order', this.value)">
                            ${enumOptions(
                                ["BIG_ENDIAN","LITTLE_ENDIAN",
                                 "BIG_ENDIAN_BYTE_SWAP","LITTLE_ENDIAN_BYTE_SWAP"],
                                ch.byte_order || "BIG_ENDIAN")}
                        </select>
                    </label>
                </div>
            </div>
        </div>
    `;
}

// ---------- Option helpers ----------

function enumOptions(list, selected) {
    return list.map(v =>
        `<option value="${v}" ${v === selected ? "selected" : ""}>${v}</option>`
    ).join("");
}
function numOptions(list, selected) {
    return list.map(v =>
        `<option value="${v}" ${Number(v) === Number(selected) ? "selected" : ""}>${v}</option>`
    ).join("");
}
function baudOptions(selected) {
    return numOptions([1200,2400,4800,9600,19200,38400,57600,115200],
                      selected ?? 9600);
}

// ---------- Collapse / expand ----------

function toggleSensor(key) {
    if (collapsedSensors.has(key)) collapsedSensors.delete(key);
    else                           collapsedSensors.add(key);

    // Re-render only that card
    const card = document.querySelector(`[data-sensor-key="${key}"]`);
    if (card) {
        card.classList.toggle("collapsed");
        card.querySelector(".sensor-body").style.display =
            card.classList.contains("collapsed") ? "none" : "";
    }
}

function toggleChannel(key) {
    if (collapsedChannels.has(key)) collapsedChannels.delete(key);
    else                            collapsedChannels.add(key);

    const el = document.querySelector(`[data-channel-key="${key}"]`);
    if (el) {
        el.classList.toggle("collapsed");
        el.querySelector(".channel-body").style.display =
            el.classList.contains("collapsed") ? "none" : "";
    }
}

function collapseAllSensors() {
    config.sensors.forEach((s, i) => collapsedSensors.add(sensorKey(s, i)));
    config.sensors.forEach((s, si) =>
        (s.channels || []).forEach((c, ci) =>
            collapsedChannels.add(channelKey(s, si, c, ci))));
    renderSensors();
}

// ---------- Mutators ----------

function setSensor(si, key, value) {
    config.sensors[si][key] = value;
    setDirty(true);

    // Update only the header summary of this sensor card
    refreshSensorHeader(si);
}

function setChannel(si, ci, key, value) {
    config.sensors[si].channels[ci][key] = value;
    setDirty(true);

    // Update the channel summary line
    refreshChannelHeader(si, ci);
}

function refreshSensorHeader(si) {
    const sensor = config.sensors[si];
    const card = document.querySelector(`[data-sensor-key="${sensorKey(sensor, si)}"]`);
    if (!card) return;

    const title = card.querySelector(".sensor-title");
    if (title) title.textContent = sensor.name || "Unnamed sensor";

    const meta = card.querySelector(".sensor-meta");
    if (meta) {
        const channels = sensor.channels || [];
        meta.innerHTML = `
            <span class="pill pill-info">Slave ${sensor.slave_id ?? 1}</span>
            <span class="pill pill-info">${sensor.baud ?? 9600} 8${(sensor.parity || "N")[0]}${sensor.stop_bits ?? 1}</span>
            <span class="pill pill-info">${channels.length} ch</span>
        `;
    }
}

function refreshChannelHeader(si, ci) {
    const sensor = config.sensors[si];
    const ch = sensor.channels[ci];
    const key = channelKey(sensor, si, ch, ci);
    const el = document.querySelector(`[data-channel-key="${key}"]`);
    if (!el) return;

    const alias = el.querySelector(".channel-alias");
    if (alias) alias.textContent = ch.alias || "Unnamed channel";

    const meta = el.querySelector(".channel-meta");
    if (meta) {
        meta.textContent =
            `${ch.register_type || "HOLDING"} @ ${ch.register_number || "0x0000"}` +
            ` · ${ch.data_type || "INT16"}` +
            ` × ${ch.scale_factor ?? 1}`;
    }
}

function addSensor() {
    if (config.sensors.length >= 12) {
        alert("Maximum 12 sensors.");
        return;
    }
    const s = {
        id: nextSensorId(),
        name: "New Sensor",
        slave_id: 1,
        baud: 9600,
        parity: "NONE",
        data_bits: 8,
        stop_bits: 1,
        retry_attempts: 3,
        recv_timeout_ms: 1000,
        channels: []
    };
    config.sensors.push(s);
    setDirty(true);
    renderSensors();
    updateSensorBadge();
}

function addChannel(si) {
    const s = config.sensors[si];
    s.channels = s.channels || [];
    if (s.channels.length >= 12) {
        alert("Maximum 12 channels per sensor.");
        return;
    }
    s.channels.push({
        id: nextChannelId(s),
        alias: "New Channel",
        register_type: "HOLDING",
        register_number: "0x00",
        scale_factor: 1,
        value_type: "ABSOLUTE",
        data_type: "INT16",
        register_width: 1,
        bit_index: -1,
        byte_order: "BIG_ENDIAN"
    });
    setDirty(true);

    // Re-render only this sensor's channel list
    const sensor = config.sensors[si];
    const card = document.querySelector(`[data-sensor-key="${sensorKey(sensor, si)}"]`);
    if (card) {
        const body = card.querySelector(".sensor-body");
        body.innerHTML = sensorBody(sensor, si);
    }
    updateSensorBadge();
}

function deleteSensor(si) {
    if (!confirm("Delete this sensor and all its channels?")) return;
    const key = sensorKey(config.sensors[si], si);
    collapsedSensors.delete(key);
    config.sensors.splice(si, 1);
    setDirty(true);
    renderSensors();
    updateSensorBadge();
}

function deleteChannel(si, ci) {
    if (!confirm("Delete this channel?")) return;
    const sensor = config.sensors[si];
    const key = channelKey(sensor, si, sensor.channels[ci], ci);
    collapsedChannels.delete(key);
    sensor.channels.splice(ci, 1);
    setDirty(true);

    const card = document.querySelector(`[data-sensor-key="${sensorKey(sensor, si)}"]`);
    if (card) {
        const body = card.querySelector(".sensor-body");
        body.innerHTML = sensorBody(sensor, si);
    }
    updateSensorBadge();
}

function nextSensorId() {
    const ids = config.sensors.map(s => Number(s.id));
    let id = 1;
    while (ids.includes(id)) id++;
    return id;
}
function nextChannelId(sensor) {
    const ids = (sensor.channels || []).map(c => Number(c.id));
    let id = 1;
    while (ids.includes(id)) id++;
    return id;
}

// ---------- Save / reset ----------

async function saveConfig() {
    if (!config) return;

    config.device.id   = $("deviceId").value;
    config.device.name = $("deviceName").value;

    config.network = {
        apn:         $("apn").value,
        apn_user:    $("apnUser").value,
        apn_pass:    $("apnPass").value,
        broker:      $("broker").value,
        broker_port: Number($("brokerPort").value),
        mqtt_user:   $("mqttUser").value,
        mqtt_pass:   $("mqttPass").value,
        pub_topic:   $("pubTopic").value,
        sub_topic:   $("subTopic").value,
        ack_topic:   $("ackTopic").value
    };

    try {
        setStatus("Saving...", true);
        const r = await fetch("/api/config", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(config)
        });
        const result = await r.json();
        if (!r.ok || !result.ok)
            throw new Error(result.message || "Save failed");

        setStatus("Saved", true);
        setDirty(false);
        alert("Configuration saved successfully.");
    } catch (e) {
        console.error(e);
        setStatus("Save failed", false);
        alert("Save failed: " + e.message);
    }
}

async function resetConfig() {
    if (!confirm("Reset all configuration?")) return;
    try {
        const r = await fetch("/api/config/reset", { method: "POST" });
        const result = await r.json();
        if (!r.ok || !result.ok)
            throw new Error(result.message || "Reset failed");
        await loadConfig();
        alert("Configuration reset.");
    } catch (e) {
        alert("Reset failed: " + e.message);
    }
}

function esc(v) {
    return String(v)
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&#039;");
}

loadConfig();