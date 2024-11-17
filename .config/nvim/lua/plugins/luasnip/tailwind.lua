local ls = require("luasnip")
local s = ls.snippet
local t = ls.text_node
local i = ls.insert_node

return {
	s("up;", { t("uppercase") }),
	s("un;", { t("underline") }),
	s("d:", { t("disabled:") }),
	s("o-", { t("opacity-") }),
	s("of-", { t("offset-") }),
	s("rd-", { t("rounded-") }),
	s("fv:", { t("focus-visible:") }),
	s("ibl", { t("inline-block") }),
	s("bgk", { t("bg-black") }),
	s("gr;", { t("group") }),
	s("gd;", { t("grid") }),
	s("gh:", { t("group-hover:") }),
	s("tz", { t("transition") }),
	s("gf:", { t("group-focus:") }),
	s("fw:", { t("focus-within:") }),
	s("il;", { t("italic") }),
	s("fm;", { t("font-medium") }),
	s("fs;", { t("font-semibold") }),
	s("fb;", { t("font-bold") }),
	s("fl;", { t("font-light") }),
	s("tx;", { t("text-xs") }),
	s("tl;", { t("text-lg") }),
	s("ts;", { t("text-sm") }),
	s("txl", { t("text-xl") }),
	s("t2x", { t("text-2xl") }),
	s("t3x", { t("text-3xl") }),
	s("t4x", { t("text-4xl") }),
	s("t5x", { t("text-5xl") }),
	s("bd", { t("border") }),
	s("oya", { t("overflow-y-auto") }),
	s("oxa", { t("overflow-x-auto") }),
	s("oyh", { t("overflow-y-hidden") }),
	s("oxh", { t("overflow-x-hidden") }),
	s("f1", { t("flex-1") }),
	s("ovh", { t("overflow-hidden") }),
	s("ova", { t("overflow-auto") }),
	s("rl;", { t("relative") }),
	s("s-", { t("shadow-"), i(1) }),
	s("bw;", { t("bg-white") }),
	s("tw;", { t("text-white") }),
	s("b-", { t("bg-"), i(1) }),
	s("t-", { t("text-"), i(1) }),
	s("df", { t("flex") }),
	s("g2", { t("gap-2") }),
	s("g4", { t("gap-4") }),
	s("gc-", { t("grid-cols-") }),
	s("gr-", { t("grid-rows-") }),
	s("cs-", { t("col-span-") }),
	s("mta", { t("mt-auto") }),
	s("mba", { t("mb-auto") }),
	s("mla", { t("ml-auto") }),
	s("mra", { t("mr-auto") }),
	s("mxa", { t("mx-auto") }),
	s("mah", { t("max-h-") }),
	s("mih", { t("min-h-") }),
	s("maw", { t("max-w-") }),
	s("mlg", { t("max-lg:") }),
	s("jb;", { t("justify-between") }),
	s("fc;", { t("flex-col") }),
	s("jc;", { t("justify-center") }),
	s("js;", { t("justify-start") }),
	s("je;", { t("justify-end") }),
	s("its;", { t("items-start") }),
	s("ite;", { t("items-end") }),
	s("ic;", { t("items-center") }),
	s("sy-", { t("space-y-") }),
	s("sx-", { t("space-x-") }),
	s("wf", { t("w-full") }),
	s("hf", { t("h-full") }),
	s("a;", { t("absolute") }),
	s("bg-", { t("bg-gray-") }),
	s("bt-", { t("bg-tertiary-") }),
	s("bm-", { t("bg-muted-") }),
	s("tm-", { t("text-muted-") }),
	s("bo-", { t("bg-overlay-") }),
	s("to-", { t("text-overlay-") }),
	s("tt-", { t("text-tertiary-") }),
	s("bs-", { t("bg-secondary-") }),
	s("ba-", { t("bg-accent-") }),
	s("ta-", { t("text-accent-") }),
	s("ts-", { t("text-secondary-") }),
	s("bp-", { t("bg-primary-") }),
	s("tp-", { t("text-primary-") }),
	s("bb-", { t("bg-brand-") }),
	s("bl-", { t("bg-blue-") }),
	s("bi-", { t("bg-indigo-") }),
	s("bn-", { t("bg-green-") }),
	s("br-", { t("bg-red-") }),
	s("by-", { t("bg-yellow-") }),
	s("tg-", { t("text-gray-") }),
	s("ti-", { t("text-indigo-") }),
	s("tn-", { t("text-green-") }),
	s("tr-", { t("text-red-") }),
	s("ty-", { t("text-yellow-") }),
	s("tb-", { t("text-brand-") }),
	s("bo-", { t("bottom-") }),
	s("to-", { t("top-") }),
	s("le-", { t("left-") }),
	s("ri-", { t("right-") }),
	s("l0", { t("left-0") }),
	s("r0", { t("right-0") }),
	s("t0", { t("top-0") }),
	s("b0", { t("bottom-0") }),
	s("i0", { t("inset-0") }),
	s("t6x", { t("text-6xl") }),
	s("sz", { t("size-") }),
	s("oj-", { t("object-") }),
	s("o-", { t("opacity-") }),
	s("hc:", { t("has-[:checked]:") }),
	s("f:", { t("focus:") }),
	s("h:", { t("hover:") }),
	s("wc", { t("w-fit") }),
	s("hc", { t("h-fit") }),
	s("tb;", { t("text-base") }),
	s("le;", { t("text-left") }),
	s("ri;", { t("text-right") }),
	s("ce;", { t("text-center") }),
	s("sro", { t("sr-only") }),
	s("d-", { t("data-["), i(1), t("]:") }),
	s("hs-", { t("has-["), i(1), t("]:") }),
	s("gh-", { t("group-has-["), i(1), t("]:") }),
	s("r-", { t("ring-") }),
	s("rg-", { t("ring-gray-") }),
	s("rz-", { t("ring-zinc-") }),
	s("rl-", { t("ring-blue-") }),
	s("ra-", { t("ring-amber-") }),
	s("rr-", { t("ring-red-") }),
	s("fr;", { t("flex-row") }),
	s("cp;", { t("cursor-pointer") }),
	s("wn;", { t("whitespace-nowrap") }),
	s("g1", { t("gap-1") }),
	s("g-", { t("gap-") }),
	s("tr;", { t("truncate") }),
	s("bk;", { t("block") }),
	s("h;", { t("hidden") }),
	s("on;", { t("outline-none") }),
	s("ws;", { t("w-screen") }),
	s("hs;", { t("h-screen") }),
	s("tz ", { t("transition ") }),
	s("du-", { t("duration-") }),
	s("eio;", { t("ease-in-out") }),
	s("tx-", { t("translate-x-") }),
	s("ty-", { t("translate-y-") }),
	s("iy-", { t("inset-y-") }),
	s("ix-", { t("inset-x-") }),
	s("fd;", { t("fixed") }),
	s("pe;", { t("pointer-events-none ") }),
}
