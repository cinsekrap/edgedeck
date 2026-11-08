// Home Assistant client over the WebSocket API (no CORS set-up needed).
(function () {
  class HAClient {
    constructor() {
      this.url = '';
      this.token = '';
      this.ws = null;
      this.status = 'not configured';
      this.states = {};
      this.listeners = new Set();
      this.pending = new Map();
      this.nextId = 1;
      this.retry = 1000;
      this.retryTimer = null;
      this.mock = false;
    }

    configure(url, token) {
      url = (url || '').trim().replace(/\/+$/, '');
      token = (token || '').trim();
      if (url === this.url && token === this.token && this.ws) return;
      this.close();
      this.url = url;
      this.token = token;
      this.retry = 1000;
      if (url === 'mock') return this.startMock();
      if (!url || !token) {
        this.setStatus('not configured');
        return;
      }
      this.connect();
    }

    close() {
      clearTimeout(this.retryTimer);
      if (this.ws) {
        this.ws.onclose = null;
        try { this.ws.close(); } catch (e) {}
      }
      this.ws = null;
      this.mock = false;
      this.states = {};
    }

    setStatus(s) {
      this.status = s;
      this.emit('*');
    }

    connect() {
      let wsUrl;
      try {
        wsUrl = this.url.replace(/^http/i, 'ws') + '/api/websocket';
        this.ws = new WebSocket(wsUrl);
      } catch (e) {
        this.setStatus('bad URL');
        return;
      }
      this.setStatus('connecting');
      this.ws.onmessage = (e) => this.handle(JSON.parse(e.data));
      this.ws.onclose = () => {
        this.ws = null;
        if (this.status === 'auth failed') return;
        this.setStatus('offline');
        this.retryTimer = setTimeout(() => this.connect(), this.retry);
        this.retry = Math.min(this.retry * 2, 30000);
      };
    }

    send(msg) {
      if (!this.ws || this.ws.readyState !== 1) return Promise.reject(new Error('Home Assistant not connected'));
      const id = this.nextId++;
      msg.id = id;
      this.ws.send(JSON.stringify(msg));
      return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
    }

    handle(m) {
      switch (m.type) {
        case 'auth_required':
          this.ws.send(JSON.stringify({ type: 'auth', access_token: this.token }));
          break;
        case 'auth_invalid':
          this.setStatus('auth failed');
          this.ws.close();
          break;
        case 'auth_ok':
          this.retry = 1000;
          this.setStatus('connected');
          this.send({ type: 'get_states' }).then((states) => {
            this.states = {};
            for (const s of states) this.states[s.entity_id] = s;
            this.emit('*');
          });
          this.send({ type: 'subscribe_events', event_type: 'state_changed' });
          break;
        case 'result': {
          const p = this.pending.get(m.id);
          if (p) {
            this.pending.delete(m.id);
            m.success ? p.resolve(m.result) : p.reject(new Error((m.error && m.error.message) || 'Failed'));
          }
          break;
        }
        case 'event': {
          const d = m.event && m.event.data;
          if (d && d.entity_id) {
            if (d.new_state) this.states[d.entity_id] = d.new_state;
            else delete this.states[d.entity_id];
            this.emit(d.entity_id);
          }
          break;
        }
      }
    }

    emit(entityId) {
      for (const fn of this.listeners) {
        try { fn(entityId); } catch (e) { console.error(e); }
      }
    }

    subscribe(fn) {
      this.listeners.add(fn);
      return () => this.listeners.delete(fn);
    }

    callService(domain, service, entityId, data = {}) {
      if (this.mock) return this.mockService(domain, service, entityId, data);
      const msg = { type: 'call_service', domain, service, service_data: data };
      if (entityId) msg.target = { entity_id: entityId };
      return this.send(msg);
    }

    imageUrl(path) {
      if (!path) return '';
      if (/^https?:|^data:/.test(path)) return path;
      return this.url + path;
    }

    // ---------- Mock for browser preview ----------
    startMock() {
      this.mock = true;
      const mk = (id, state, attrs) => ({ entity_id: id, state, attributes: attrs });
      this.states = {
        'light.office': mk('light.office', 'on', { friendly_name: 'Office', brightness: 180, supported_color_modes: ['brightness'] }),
        'light.lounge': mk('light.lounge', 'off', { friendly_name: 'Lounge lamps', supported_color_modes: ['brightness'] }),
        'switch.hot_tub_heater': mk('switch.hot_tub_heater', 'on', { friendly_name: 'Hot tub heater' }),
        'sensor.hot_tub_temperature': mk('sensor.hot_tub_temperature', '37.5', { friendly_name: 'Hot tub', unit_of_measurement: '°C', device_class: 'temperature' }),
        'sensor.polestar_battery': mk('sensor.polestar_battery', '82', { friendly_name: 'Polestar battery', unit_of_measurement: '%', device_class: 'battery' }),
        'lock.front_door': mk('lock.front_door', 'locked', { friendly_name: 'Front door' }),
        'camera.drive': mk('camera.drive', 'idle', { friendly_name: 'Drive', entity_picture: '' }),
        'climate.hallway': mk('climate.hallway', 'heat', { friendly_name: 'Heating', current_temperature: 20.5, temperature: 21 }),
      };
      this.setStatus('connected');
    }

    mockService(domain, service, entityId, data) {
      const s = this.states[entityId];
      if (s) {
        if (service === 'toggle') s.state = s.state === 'on' ? 'off' : 'on';
        else if (service === 'turn_on') { s.state = 'on'; if (data.brightness_pct != null) s.attributes.brightness = Math.round(data.brightness_pct * 2.55); }
        else if (service === 'turn_off') s.state = 'off';
        else if (service === 'lock') s.state = 'locked';
        else if (service === 'unlock') s.state = 'unlocked';
        this.emit(entityId);
      }
      return Promise.resolve();
    }
  }

  window.HA = new HAClient();
})();
