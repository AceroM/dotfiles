local ls = require("luasnip")
local s = ls.snippet
local t = ls.text_node
local i = ls.insert_node

return {
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
	s("e;", { t("each do |"), i(1), t("|"), t({ "", "  " }), i(2), t({ "", "end" }) }),
	s("do", { t("do"), t({ "", "  " }), i(1), t({ "", "end" }) }),
	s("d;", { t("do |"), i(1), t("|"), t({ "", "  " }), i(2), t({ "", "end" }) }),
	s("rf ", { t("rescue_from ") }),
	s("rb ", { t("redirect_back ") }),
	s("rt ", { t("redirect_to ") }),
	s("c ", { t("class "), i(1), t({ "", "end" }) }),
	s("cm ", { t("class_methods do"), t({ "", "  " }), i(1), t({ "", "end" }) }),
	s("m ", { t("module "), i(1), t({ "", "end" }) }),
	s("eac", { t("extend ActiveSupport::Concern") }),
	s("ind ", { t("included do"), t({ "", "  " }), i(1), t({ "", "end" }) }),
	s("ba ", { t("before_action :"), i(1) }),
	s("bt ", { t("belongs_to :"), i(1), t(", optional: true") }),
	s("aa ", { t("after_action :"), i(1) }),
	s("r ", { t("return "), i(1) }),
	s("rd", { t("render "), i(1) }),
	s("ri ", { t("render inertia: "), i(1) }),
	s("pv ", { t("private "), t({ "", "" }) }),
	s("pr ", { t("protected "), t({ "", "" }) }),
	s("fi ", { t("if "), i(1), t(" "), i(2), t({ "", "end" }) }),
	s("fsl", { t("# frozen_string_literal: true") }),
	s("cu ", { t("current_user") }),
	s("ar ", { t("attr_reader :") }),
	s("ae ", { t("assert_equal ") }),
	s("d ", { t("def "), i(1), t({ "  ", "end" }) }),
	s("hm ", { t("has_many :"), i(1), t(", dependent: :destroy") }),
}
