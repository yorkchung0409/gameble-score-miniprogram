Component({
  properties: {
    options: { type: Array, value: [] },
    values: { type: Array, value: [] },
    value: { type: String, value: "" },
    placeholder: { type: String, value: "选择" },
    title: { type: String, value: "选择牌" },
    max: { type: Number, value: 1 },
    player: { type: String, value: "" },
    group: { type: String, value: "" },
    boardIndex: { type: Number, value: -1 },
    cardIndex: { type: Number, value: -1 }
  },

  data: { selectedIndex: 0, selectedValues: [], draftValues: [], displayValue: "选择牌", suitClass: "card-empty", open: false, cardOptions: [] },

  observers: {
    "options, value, values": function (options, value, values) {
      const list = Array.isArray(options) ? options : [];
      const index = list.findIndex((item) => item && item.value === value);
      const incoming = Array.isArray(values) ? values.filter(Boolean) : (value ? [value] : []);
      const selectedValues = incoming.slice(0, Math.max(1, Number(this.properties.max) || 1));
      const card = selectedValues[0] || "";
      const rank = card ? card[0].toUpperCase() : "";
      const suit = card ? { s: "♠", h: "♥", d: "♦", c: "♣" }[card[1].toLowerCase()] : "";
      this.setData({
        selectedIndex: index >= 0 ? index : 0,
        selectedValues,
        displayValue: card && suit ? `${rank}${suit}` : (this.properties.placeholder || "选择牌"),
        suitClass: card && /[hd]/i.test(card[1]) ? "card-red" : card ? "card-black" : "card-empty",
        cardOptions: this.decorateOptions(list, selectedValues)
      });
    }
  },

  methods: {
    formatCard(value) {
      const card = typeof value === "string" ? value : "";
      const suit = card ? { s: "♠", h: "♥", d: "♦", c: "♣" }[card[1].toLowerCase()] : "";
      return {
        label: card && suit ? `${card[0].toUpperCase()}${suit}` : "",
        className: /[hd]/i.test(card[1] || "") ? "card-red" : "card-black"
      };
    },

    decorateOptions(options, selectedValues) {
      const selected = new Set(selectedValues);
      return options.filter((item) => item && item.value).map((item) => {
        const display = this.formatCard(item.value);
        return {
          ...item,
          displayLabel: display.label,
          suitClass: display.className,
          selected: selected.has(item.value)
        };
      });
    },

    openPicker() {
      this.setData({ open: true, draftValues: this.data.selectedValues.slice(), cardOptions: this.decorateOptions(this.properties.options || [], this.data.selectedValues) });
    },

    closePicker() {
      this.setData({ open: false });
    },

    stopPropagation() {},

    onMaskTap() {
      this.closePicker();
    },

    toggleCard(event) {
      const value = event.currentTarget.dataset.value;
      if (!value) return;
      const option = (this.data.cardOptions || []).find((item) => item.value === value);
      if (!option || option.disabled) return;
      const current = this.data.draftValues || [];
      const exists = current.includes(value);
      let next;
      if (exists) next = current.filter((item) => item !== value);
      else if (current.length < Math.max(1, Number(this.properties.max) || 1)) next = current.concat(value);
      else return;
      this.setData({ draftValues: next, cardOptions: this.decorateOptions(this.properties.options || [], next) });
    },

    clearCards() {
      this.setData({ draftValues: [], cardOptions: this.decorateOptions(this.properties.options || [], []) });
    },

    confirmCards() {
      const values = (this.data.draftValues || []).slice();
      this.setData({ open: false, selectedValues: values, cardOptions: this.decorateOptions(this.properties.options || [], values) });
      this.triggerEvent("select", {
        values,
        value: values[0] || "",
        boardIndex: this.properties.boardIndex,
        player: this.properties.player,
        group: this.properties.group,
        cardIndex: this.properties.cardIndex
      });
    },

  }
});
