local ls = require("luasnip")
local s = ls.snippet
local t = ls.text_node
local i = ls.insert_node

return {
  s("d:", { t("disabled:") }),
  s("o-", { t("opacity-") }),
  s("of-", { t("offset-") }),
  s("rd-", { t("rounded-") }),
  s("tr-", { t("transition-") }),
  s("fv:", { t("focus-visible:") }),
  s("ibl", { t("inline-block") }),
  s("bgk", { t("bg-black") }),
  s("gr ", { t("group ") }),
  s("gd ", { t("grid ") }),
  s("grh:", { t("group-hover:") }),
  s("tz", { t("transition") }),
  s("grf:", { t("group-focus:") }),
  s("fw:", { t("focus-within:") }),
  s("itl", { t("italic") }),
  s("fmd", { t("font-medium") }),
  s("fsb", { t("font-semibold") }),
  s("fbd", { t("font-bold") }),
  s("flt", { t("font-light") }),
  s("txs", { t("text-xs") }),
  s("tlg", { t("text-lg") }),
  s("tsm", { t("text-sm") }),
  s("txl", { t("text-xl") }),
  s("t2x", { t("text-2xl") }),
  s("t3x", { t("text-3xl") }),
  s("t4x", { t("text-4xl") }),
  s("t5x", { t("text-5xl") }),
  s("bd", { t("border") }),
  s("l0", { t("left-0") }),
  s("oya", { t("overflow-y-auto") }),
  s("oxa", { t("overflow-x-auto") }),
  s("oyh", { t("overflow-y-hidden") }),
  s("oxh", { t("overflow-x-hidden") }),
  s("f1", { t("flex-1") }),
  s("ovh", { t("overflow-hidden") }),
  s("rel ", { t("relative") }),
  s("sh ", { t("shadow-"), i(1) }),
  s("bgw", { t("bg-white") }),
  s("tw ", { t("text-white") }),
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
  s("jb;", { t("justify-between") }),
  s("fc;", { t("flex-col") }),
  s("jc;", { t("justify-center") }),
  s("js;", { t("justify-start") }),
  s("je;", { t("justify-end") }),
  s("is;", { t("items-start") }),
  s("ie;", { t("items-end") }),
  s("ic;", { t("items-center") }),
  s("spy", { t("space-y-") }),
  s("spx", { t("space-x-") }),
  s("wf", { t("w-full") }),
  s("hf", { t("h-full") }),
  s("rl;", { t("relative") }),
  s("ab;", { t("absolute") }),
  s("bgg", { t("bg-gray-") }),
  s("bgt", { t("bg-tertiary-") }),
  s("bgm", { t("bg-muted-") }),
  s("tm-", { t("text-muted-") }),
  s("bgo", { t("bg-overlay-") }),
  s("to-", { t("text-overlay-") }),
  s("tt-", { t("text-tertiary-") }),
  s("bgs", { t("bg-secondary-") }),
  s("bga", { t("bg-accent-") }),
  s("ta-", { t("text-accent-") }),
  s("ts-", { t("text-secondary-") }),
  s("bgp", { t("bg-primary-") }),
  s("tp-", { t("text-primary-") }),
  s("bgb", { t("bg-brand-") }),
  s("bgr", { t("bg-red-") }),
  s("bgy", { t("bg-yellow-") }),
  s("teg", { t("text-gray-") }),
  s("teb", { t("text-brand-") }),
  s("r0", { t("right-0") }),
  s("t0", { t("top-0") }),
  s("b0", { t("bottom-0") }),
  s("i0", { t("inset-0") }),
  s("t6x", { t("text-6xl") }),
  s("sz", { t("size-") }),
  s("oj-", { t("object-") }),
  s("op ", { t("opacity-") }),
  s("hc:", { t("has-[:checked]:") }),
  s("f:", { t("focus:") }),
  s("h:", { t("hover:") }),
  s("wc", { t("w-fit") }),
  s("hc", { t("h-fit") }),
  s("teb ", { t("text-base") }),
  s("tece", { t("text-center") }),
  s("sro", { t("sr-only") }),
  s("d-", { t("data-["), i(1), t("]:") }),
  s("hs-", { t("has-["), i(1), t("]:") }),
  s("gh-", { t("group-has-["), i(1), t("]:") }),
  s("r-", { t("ring-") }),
  s("rg-", { t("ring-gray-") }),
  s("bob", { t("border-b") }),
  s("bor", { t("border-r") }),
  s("bol", { t("border-l") }),
  s("bot ", { t("border-t") }),
  s("bt-", { t("border-t-"), i(1) }),
  s("bl-", { t("border-l-"), i(1) }),
  s("br-", { t("border-r-"), i(1) }),
  s("bb-", { t("border-b-"), i(1) }),
  s("fr;", { t("flex-row") }),
  s("cur ", { t("cursor-pointer") }),
  s("wsn", { t("whitespace-nowrap") }),
  s("g1", { t("gap-1") }),
  s("g-", { t("gap-") }),
  s("tr;", { t("truncate") }),
  s("bk;", { t("block") }),
  s("h;", { t("hidden") }),
  s("mlg", { t("max-lg:") }),
  s("oun", { t("outline-none") }),
  s("ws;", { t("w-screen") }),
  s("hs;", { t("h-screen") }),
  s("tz ", { t("transition ") }),
  s("du-", { t("duration-") }),
  s("eio ", { t("ease-in-out") }),
  s("tx-", { t("translate-x-") }),
  s("ty-", { t("translate-y-") }),
  s("iy0", { t("inset-y-0") }),
  s("ix0", { t("inset-x-0") }),
  s("iyh", { t("inset-y-0") }),
  s("ixh", { t("inset-x-0") }),
  s("fd;", { t("fixed") }),
  s("pen ", { t("pointer-events-none ") }),
}
