local ls = require("luasnip")
local s = ls.snippet
local t = ls.text_node
local i = ls.insert_node

return {
  s("hl,", { t("<html>"), i(1), t("</html>") }),
  s("hd,", { t("<head>"), i(1), t("</head>") }),
  s("bd,", { t("<body>"), i(1), t("</body>") }),
  s("tit,", { t("<title>"), i(1), t("</title>") }),
  s("mt,", { t("<meta "), i(1), t(" />") }),
  s("at,", { t("<link "), i(1), t(" />") }),
  s("scr,", { t("<script>"), i(1), t("</script>") }),
  s("sty,", { t("<style>"), i(1), t("</style>") }),
  s("sec,", { t("<section>"), i(1), t("</section>") }),
  s("art,", { t("<article>"), i(1), t("</article>") }),
  s("nv,", { t("<nav>"), i(1), t("</nav>") }),
  s("asd,", { t("<aside>"), i(1), t("</aside>") }),
  s("hdr,", { t("<header>"), i(1), t("</header>") }),
  s("ftr,", { t("<footer>"), i(1), t("</footer>") }),
  s("tbd", { t({ "<tbody>", "  " }), i(1), t({ "", "</tbody>" }) }),
  s("tbf", { t({ "<tfoot>", "  " }), i(1), t({ "", "</tfoot>" }) }),
  s("thd", { t({ "<thead>", "  " }), i(1), t({ "", "</thead>" }) }),
  s("tr,", { t({ "<tr>", "  " }), i(1), t({ "", "</tr>" }) }),
  s("th,", { t("<th>"), i(1), t("</th>") }),
  s("td,", { t("<td>"), i(1), t("</td>") }),
  s("h1,", { t("<h1>"), i(1), t("</h1>") }),
  s("h2,", { t("<h2>"), i(1), t("</h2>") }),
  s("h3,", { t("<h3>"), i(1), t("</h3>") }),
  s("h4,", { t("<h4>"), i(1), t("</h4>") }),
  s("d,", { t("<div>"), i(1), t("</div>") }),
  s("dl,", { t("<dl>"), i(1), t("</dl>") }),
  s("dt,", { t("<dt>"), i(1), t("</dt>") }),
  s("dd,", { t("<dd>"), i(1), t("</dd>") }),
  s("s,", { t("<span>"), i(1), t("</span>") }),
  s("b,", { t("<button>"), i(1), t("</button>") }),
  s("b,", { t("<form>"), i(1), t("</form>") }),
  s("u,", { t("<ul>"), i(1), t("</ul>") }),
  s("p,", { t("<p>"), i(1), t("</p>") }),
  s("li,", { t("<li>"), i(1), t("</li>") }),
  s("f,", { t("<form>"), i(1), t("</form>") }),
  s("main,", { t("<main>"), i(1), t("</main>") }),
  s("ul,", { t("<ul>"), i(1), t("</ul>") }),
  s("ipt", { t('<input type="text" '), i(1), t(" />") }),
  s("ipc", { t('<input type="checkbox" '), i(1), t(" />") }),
  s("ipn", { t('<input type="number" '), i(1), t(" />") }),
  s("ipe", { t('<input type="email" '), i(1), t(" />") }),
  s("imt", { t('<img src="'), i(1), t('" alt="'), i(2), t('"/>') }),
  s("at,", { t('<a href="'), i(1), t('"/>') }),
}