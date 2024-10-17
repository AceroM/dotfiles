local ls = require("luasnip")
local s = ls.snippet
local t = ls.text_node
local i = ls.insert_node

return {
	s("R.", { t("Rails.") }),
	s("a.", { t("application.") }),
	s("c.", { t("credentials.") }),
	s("r.", { t("routes.") }),
	s("u_", { t("url_helpers") }),
	s("ca;", { t("create_table :"), i(1), t(" do |t|"), t({ "", "  " }), i(2), t({ "", "end" }) }),
	s("p:", { t("polymorphic: ") }),
	s("n:", { t("null: ") }),
	s("i:", { t("index: ") }),
	s("rs;", { t("respond_to do |format|"), t({ "", "  " }), i(1), t({ "", "end" }) }),
	s("o:", { t("only: %i["), i(1), t("]") }),
	s("ct:", { t("content_tag :") }),
	s("c:", { t('class: "'), i(1), t('"') }),
	s("c_", { t("card_") }),
	s("t_", { t("tooltip_") }),
	s("p_", { t("popover_") }),
	s("lb_", { t("listbox_") }),
	s("dr_", { t("dropdown_") }),
	s("d_", { t("dialog_") }),
	s("r_", { t("render_") }),
	s("t.s", { t("t.string :") }),
	s("t.t", { t("t.text :") }),
	s("t.z", { t("t.timestamps") }),
	s("t.r", { t("t.references :") }),
	s("t.b", { t("t.boolean :") }),
	s("t.i", { t("t.integer :") }),
	s("i;", { t("include ") }),
	s("ts:", { t("turbo_stream: ") }),
	s("di ", { t("def initialize("), i(1), t(")"), t({ "", "  " }), i(2), t({ "", "end" }) }),
	s("rq", { t('require "'), i(1), t('"') }),
	s("s,", { t("span do"), t({ "", "  " }), i(1), t({ "", "end" }) }),
	s("n,", { t("nav do"), t({ "", "  " }), i(1), t({ "", "end" }) }),
	s("u,", { t("ul do"), t({ "", "  " }), i(1), t({ "", "end" }) }),
	s("u.", { t('ul(class: "'), i(1), t('")') }),
	s("l,", { t("li do"), t({ "", "  " }), i(1), t({ "", "end" }) }),
	s("m,", { t("main do"), t({ "", "  " }), i(1), t({ "", "end" }) }),
	s("p,", { t("p do"), t({ "", "  " }), i(1), t({ "", "end" }) }),
	s("d,", { t("div do"), t({ "", "  " }), i(1), t({ "", "end" }) }),
	s("t:", { t("task :"), i(1), t({ " => :environment do" }, { "", "  " }), i(2), t({ "", "end" }) }),
	s("e;", { t("each do |"), i(1), t("|"), t({ "", "  " }), i(2), t({ "", "end" }) }),
	s("do;", { t("do"), t({ "", "  " }), i(1), t({ "", "end" }) }),
	s("de;", { t("do |"), i(1), t("|"), t({ "", "  " }), i(2), t({ "", "end" }) }),
	s("rf ", { t("rescue_from ") }),
	s("rb ", { t("redirect_back ") }),
	s("rt ", { t("redirect_to ") }),
	s("c ", { t("class "), i(1), t({ "", "end" }) }),
	s("cm ", { t("class_methods do"), t({ "", "  " }), i(1), t({ "", "end" }) }),
	s("m ", { t("module "), i(1), t({ "", "end" }) }),
	s("eac", { t("extend ActiveSupport::Concern") }),
	s("ind ", { t("included do"), t({ "", "  " }), i(1), t({ "", "end" }) }),
	s("sba:", { t("skip_before_action :"), i(1) }),
	s("ba:", { t("before_action :"), i(1) }),
	s("bt:", { t("belongs_to :") }),
	s("aa:", { t("after_action :"), i(1) }),
	s("r ", { t("return "), i(1) }),
	s("rd", { t("render "), i(1) }),
	s("ri ", { t("render inertia: "), i(1) }),
	s("pv ", { t("private "), t({ "", "", "" }) }),
	s("pr ", { t("protected "), t({ "", "" }) }),
	s("fi ", { t("if "), i(1), t(" "), i(2), t({ "", "end" }) }),
	s("ei ", { t("elsif "), i(1), t(" "), i(2), t({ "", "end" }) }),
	s("el ", { t("else "), t({ "", "  " }), i(1), t({ "", "end" }) }),
	s("fsl", { t("# frozen_string_literal: true") }),
	s("cu ", { t("current_user") }),
	s("ar:", { t("attr_reader :") }),
	s("aw:", { t("attr_writer :") }),
	s("ae ", { t("assert_equal ") }),
	s("d ", { t("def "), i(1), t({ "  ", "end" }) }),
	s("hm:", { t("has_many :") }),
	s("d:", { t("dependent: :destroy") }),
	s("a:", { t("as: :") }),
}
