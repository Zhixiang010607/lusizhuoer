Component({
  properties: { value: { type: String, value: "clockIn" }, disabled: { type: Boolean, value: false } },
  methods: {
    choose(event) {
      const kind = event.currentTarget.dataset.kind;
      if (!this.data.disabled && ["clockIn", "clockOut"].includes(kind) && kind !== this.data.value) this.triggerEvent("change", { kind });
    }
  }
});
