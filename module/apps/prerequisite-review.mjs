/**
 * Review of feat prerequisites (GM-only settings menu).
 *
 * Prerequisite rows are read top to bottom, each row's "and" / "or" combining
 * it with everything above it, and rows that belong together are bracketed
 * into a group. Feats saved before groups existed may read differently now,
 * and only their author knows what was meant, so nothing is converted
 * automatically: this window lists those feats (see findFeatsToReview in
 * module/migration.mjs) with how each read before and how it reads now, and
 * lets the GM open each one to edit it, or keep it as it reads now.
 */

import { findFeatsToReview } from "../migration.mjs";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

export class OpenLegendPrerequisiteReview extends HandlebarsApplicationMixin(ApplicationV2) {

  /** @override */
  static DEFAULT_OPTIONS = {
    id: "openlegend-prerequisite-review",
    classes: ["openlegend", "ol-prerequisite-review"],
    window: { title: "Review Feat Prerequisites", icon: "fas fa-list-check", resizable: true, contentClasses: ["standard-form"] },
    position: { width: 680, height: 700 },
    actions: {
      openFeat: OpenLegendPrerequisiteReview.#onOpenFeat,
      keepFeat: OpenLegendPrerequisiteReview.#onKeepFeat,
      refresh: OpenLegendPrerequisiteReview.#onRefresh
    }
  };

  /** @override */
  static PARTS = {
    body: { template: "systems/tomucatos-open-legend-rpg-system/templates/apps/prerequisite-review.html", scrollable: [""] }
  };

  /** The feats found by the last scan, in the order they are listed. */
  #feats = [];

  /** Re-scan whenever an item is saved while the window is open. */
  #onItemUpdate = foundry.utils.debounce(() => { if ( this.rendered ) this.render(); }, 200);

  /** @override */
  async _prepareContext() {
    this.#feats = await findFeatsToReview();
    return {
      feats: this.#feats.map((f, index) => ({ index, name: f.name, where: f.where, tiers: f.tiers, canOpen: !!f.item, multiTier: f.tiers.some(t => t.tier > 1) }))
    };
  }

  /** @override */
  async _onFirstRender(context, options) {
    await super._onFirstRender(context, options);
    Hooks.on("updateItem", this.#onItemUpdate);
  }

  /** @override */
  _onClose(options) {
    Hooks.off("updateItem", this.#onItemUpdate);
    super._onClose(options);
  }

  /** Open the feat's sheet so its prerequisites can be edited. */
  static #onOpenFeat(event, target) {
    this.#feats[Number(target.dataset.index)]?.item?.sheet?.render({ force: true });
  }

  /** Keep the feat as it reads now and drop it from the list. */
  static async #onKeepFeat(event, target) {
    try { await this.#feats[Number(target.dataset.index)]?.accept(); }
    catch ( err ) { ui.notifications?.error(`Open Legend: could not update that feat (${err.message}).`); }
    this.render();
  }

  static #onRefresh() {
    this.render();
  }
}
