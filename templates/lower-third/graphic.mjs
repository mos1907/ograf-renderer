/**
 * OGraf Lower Third — EBU OGraf v1 Spec-compliant Web Component
 *
 * Required methods: play(), stop(), update(data), next()
 * Tag name must match manifest "id": <ograf-lower-third>
 */

const template = document.createElement('template');
template.innerHTML = `
<style>
  :host {
    display: block;
    width: 100%;
    height: 100%;
    position: relative;
    font-family: 'Segoe UI', 'Arial', sans-serif;
    overflow: hidden;
  }

  .container {
    position: absolute;
    bottom: 80px;
    left: 60px;
    display: flex;
    flex-direction: column;
    gap: 2px;
    transform: translateX(-120%);
    transition: transform 0.6s cubic-bezier(0.25, 0.46, 0.45, 0.94);
  }

  :host([data-state="in"]) .container {
    transform: translateX(0);
  }

  :host([data-state="out"]) .container {
    transform: translateX(-120%);
  }

  .name-bar {
    background: rgba(0, 120, 215, 0.95);
    color: white;
    padding: 12px 30px;
    font-size: 32px;
    font-weight: 700;
    letter-spacing: 0.5px;
    clip-path: polygon(0 0, 100% 0, calc(100% - 15px) 100%, 0 100%);
    min-width: 300px;
  }

  .title-bar {
    background: rgba(30, 30, 30, 0.9);
    color: rgba(255, 255, 255, 0.95);
    padding: 8px 30px;
    font-size: 22px;
    font-weight: 400;
    letter-spacing: 0.3px;
    clip-path: polygon(0 0, 100% 0, calc(100% - 10px) 100%, 0 100%);
    min-width: 250px;
  }

  .accent-line {
    width: 0;
    height: 3px;
    background: linear-gradient(90deg, #0078d7, #00bcf2);
    transition: width 0.4s ease 0.3s;
  }

  :host([data-state="in"]) .accent-line {
    width: 100%;
  }
</style>

<div class="container">
  <div class="accent-line"></div>
  <div class="name-bar"><span id="name"></span></div>
  <div class="title-bar"><span id="title"></span></div>
</div>
`;

class OGrafLowerThird extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    this.shadowRoot.appendChild(template.content.cloneNode(true));
    this._data = {};
  }

  /**
   * OGraf play() — Grafiği ekrana getir (animate in)
   */
  play() {
    this.setAttribute('data-state', 'in');
    console.log('[OGraf] Lower Third: play');
  }

  /**
   * OGraf stop() — Grafiği ekrandan çıkar (animate out)
   */
  stop() {
    this.setAttribute('data-state', 'out');
    console.log('[OGraf] Lower Third: stop');
  }

  /**
   * OGraf next() — Sonraki adıma geç
   */
  next() {
    console.log('[OGraf] Lower Third: next (stepCount=1, no-op)');
  }

  /**
   * OGraf update(data) — Veriyi güncelle
   * @param {Object} data - { name: string, title: string }
   */
  update(data) {
    this._data = { ...this._data, ...data };

    const nameEl = this.shadowRoot.getElementById('name');
    const titleEl = this.shadowRoot.getElementById('title');

    if (nameEl && data.name !== undefined) {
      nameEl.textContent = data.name;
    }
    if (titleEl && data.title !== undefined) {
      titleEl.textContent = data.title;
    }

    console.log('[OGraf] Lower Third: update', data);
  }
}

customElements.define('ograf-lower-third', OGrafLowerThird);
