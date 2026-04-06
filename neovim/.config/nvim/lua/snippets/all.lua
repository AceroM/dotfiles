local ls = require("luasnip")
local s = ls.snippet
local f = ls.function_node
local t = ls.text_node
local i = ls.insert_node
local fmt = require("luasnip.extras.fmt").fmt

local function return_filename(args, parent)
  return vim.fn.expand("%:t:r")
end

local function return_filename_pascal_case(args, parent)
  local filename = vim.fn.expand("%:t:r")
  local pascal = filename:gsub("%-(%w)", function(letter)
    return letter:upper()
  end)
  return pascal:sub(1, 1):upper() .. pascal:sub(2)
end

local function clipboard()
  return vim.fn.getreg("+")
end

return {
  s("gl;", fmt("getLayout = (page: ReactNode) => (\n\t{}\n)", { i(0) })),
  s("inr;", { t("import { useRouter } from 'next/router';") }),
  s("nr;", { t("const router = useRouter();") }),
  s("cx ", { t("ctx.db.") }),
  s("pe;", { t("process.exit(0)") }),
  s("fc;", { f(return_filename) }),
  s("fn;", { f(return_filename_pascal_case) }),
  s(
    "fe;",
    fmt(
      [[{{!field.state.meta.isValid && (
  <em role="alert">{{field.state.meta.errors?.[0]?.message}}</em>
)}}]],
      {}
    )
  ),
  s(
    "dc;",
    fmt(
      [[import {{ Button }} from "@/components/ui/button";
import {{
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
}} from "@/components/ui/dialog";

export function {}({{
    open,
    onOpenChange,
}}: {{
    open: boolean;
    onOpenChange: (open: boolean) => void;
}}) {{
    return (
        <Dialog open={{open}} onOpenChange={{onOpenChange}}>
            <DialogContent>
                <DialogHeader>
                    <DialogTitle>Enter info</DialogTitle>
                    <DialogDescription>
                        Please enter your info.
                    </DialogDescription>
                </DialogHeader>
                {}
                <DialogFooter>
                    <Button variant="outline" onClick={{() => onOpenChange(false)}}>
                        Cancel
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}}]],
      { f(return_filename_pascal_case), i(1) }
    )
  ),
  s("l8", { t("http://localhost:8080") }),
  s("l3", { t("http://localhost:3000") }),
  s("cj,", { t("content-type: application/json") }),
  s("aj,", { t("accept: application/json") }),
  s("aa,", { t("authorization: {{AUTH}}") }),
  s("mgm", { t("miguelacero528@gmail.com") }),
  s("uf ", fmt("useForm({{\n\t{}\n}})", { i(0) })),
  s("fs;", fmt("onSubmit: async ({{ value }}) => {{\n\t{}\n}}", { i(0) })),
  s("ds ", fmt("disabled={{{}}}", { i(0) })),
  s("m;", fmt("map({})", { i(0) })),
  s("l;", { t("length") }),
  s("lk;", { t("<Link>"), i(1), t("</Link>") }),
  s("lki;", { t('import { Link } from "@tanstack/react-router";') }),
  s("b;", { t("<Button>"), i(1), t("</Button>") }),
  s("bo;", { t('<Button variant="outline">'), i(1), t("</Button>") }),
  s("bg;", { t('<Button variant="ghost">'), i(1), t("</Button>") }),
  s("df;", { t("<DialogFooter>"), i(1), t("</DialogFooter>") }),
  s("bi;", { t("import { Button } from '@/components/ui/button';") }),
  s("ph ", fmt('placeholder="{}"', { i(0) })),
  s("fv;", { t("field.state.value") }),
  s("fh;", { t("onChange={(e) => field.handleChange(e.target.value)}") }),
  s("tai;", { t("import { Textarea } from '@/components/ui/textarea';") }),
  s("f;", fmt("function {}() {{\n}}", { i(0) })),
  s("ef ", fmt("export function {}() {{\n}}", { i(0) })),
  s("edf ", fmt("export default function {}() {{\n}}", { i(0) })),
  s("ta;", fmt("<Textarea\n\t{}\n/>", i(0))),
  s("i;", fmt("<Input\n\t{}\n/>", i(0))),
  s("ii;", { t("import { Input } from '@/components/ui/input';") }),
  s("lb ", { t("<Label htmlFor={field.name}>"), i(1), t("</Label>") }),
  s("lbi;", { t("import { Label } from '@/components/ui/label';") }),
  s(
    "sli;",
    { t("import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';") }
  ),
  s(
    "sl;",
    fmt(
      '<Select>\n\t<SelectTrigger>\n\t\t<SelectValue placeholder="{}" />\n\t</SelectTrigger>\n\t<SelectContent>\n\t</SelectContent>\n</Select>',
      { i(0) }
    )
  ),
  s("dmi;", {
    t(
      "import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';"
    ),
  }),
  s("pi;", {
    t("import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';"),
  }),
  s(
    "po;",
    fmt(
      [[<Popover>
  <PopoverTrigger>Open</PopoverTrigger>
  <PopoverContent>Place content for the popover here.</PopoverContent>
</Popover>]],
      {}
    )
  ),
  s(
    "poi;",
    fmt(
      [[import {{
  Popover,
  PopoverContent,
  PopoverTrigger,
}} from "@/components/ui/popover"]],
      {}
    )
  ),
  s("tti;", {
    t("import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';"),
  }),
  s(
    "tt;",
    fmt(
      [[<Tooltip>
  <TooltipTrigger asChild>{}</TooltipTrigger>
  <TooltipContent>content</TooltipContent>
</Tooltip>]],
      { i(0) }
    )
  ),
  s("di;", {
    t(
      "import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';"
    ),
  }),
  s("n ", { t('className="'), i(1), t('"') }),
  s("d ", { t("<div>"), i(1), t("</div>") }),
  s("rf ", { t("<React.Fragment>"), i(1), t("</React.Fragment>") }),
  s("d. ", fmt('<div className="{}">\n</div>', { i(0) })),
  s("sp ", { t("<span>"), i(1), t("</span>") }),
  s("vs ", { t("validateSearch: ") }),
  s("dv ", { t("defaultValues: { "), i(1), t(" }") }),
  s("ar ", fmt("args: {{{}}}", { i(0) })),
  s("zo ", { t("z.object({ {{}} })") }),
  s("sp. ", fmt('<span className="{}">\n</span>', { i(0) })),
  s("h1;", { t("<h1>"), i(1), t("</h1>") }),
  s("h2;", { t("<h2>"), i(1), t("</h2>") }),
  s("h3;", { t("<h3>"), i(1), t("</h3>") }),
  s("h4;", { t("<h4>"), i(1), t("</h4>") }),
  s("p;", { t("<p>"), i(1), t("</p>") }),
  s("p. ", { t('<p className="'), i(1), t('">'), i(2), t("</p>") }),
  s("tm;", { t("text-sm font-medium") }),
  s("tr ", { t("text-red-") }),
  s("tg ", { t("text-gray-") }),
  s("vd ", fmt("validators={{{{ onSubmit: {} }}}}", { i(0) })),
  s("un;", { t("underline") }),
  s("it;", { t("italic") }),
  s("tw;", { t("text-white") }),
  s("xs;", { t("text-xs") }),
  s("op ", { t("opacity-") }),
  s("tmf;", { t("text-muted-foreground") }),
  s("bw;", { t("bg-white") }),
  s("hv ", { t("hover:") }),
  s("gh ", { t("group-hover:") }),
  s("tr;", { t("truncate") }),
  s("sh ", { t("shadow-") }),
  s("ts;", { t("text-sm") }),
  s("tl;", { t("text-lg") }),
  s("tx;", { t("text-xl") }),
  s("mw ", { t("max-w-") }),
  s("ma;", { t("mx-auto") }),
  s("mh ", { t("max-h-") }),
  s("xc;", { t("flex flex-col") }),
  s("xr;", { t("flex-row") }),
  s("fm;", { t("font-medium") }),
  s("sb;", { t("font-semibold") }),
  s("bd;", { t("border") }),
  s("bd ", { t("border-") }),
  s("g ", { t("grid ") }),
  s("ga ", { t("gap-") }),
  s("rd ", { t("rounded-") }),
  s("re;", { t("relative") }),
  s("ab;", { t("absolute") }),
  s("fi;", { t("fixed") }),
  s("st;", { t("sticky") }),
  s("tp ", { t("top-") }),
  s("rh ", { t("right-") }),
  s("bt ", { t("bottom-") }),
  s("lf ", { t("left-") }),
  s("fs0", { t("flex-shrink-0") }),
  s("oh;", { t("overflow-hidden") }),
  s("ya;", { t("overflow-y-auto") }),
  s("yh;", { t("overflow-y-hidden") }),
  s("xa;", { t("overflow-x-auto") }),
  s("xh;", { t("overflow-x-hidden") }),
  s("sy ", { t("space-y-") }),
  s("sx ", { t("space-x-") }),
  s("va ", { t('variant="'), i(1), t('"') }),
  s("si ", { t('size="'), i(1), t('"') }),
  s("gc ", { t("grid-cols-") }),
  s("cs ", { t("col-span-") }),
  s("cp;", { t("font-medium") }),
  s("x;", { t("flex") }),
  s("f1;", { t("flex-1") }),
  s("xij;", { t("flex items-center justify-center") }),
  s("xi;", { t("flex items-center") }),
  s("ic;", { t("items-center") }),
  s("is;", { t("items-start") }),
  s("ie;", { t("items-end") }),
  s("jc;", { t("justify-center") }),
  s("js;", { t("justify-start") }),
  s("je;", { t("justify-end") }),
  s("jb;", { t("justify-between") }),
  s("wf;", { t("w-full") }),
  s("hf;", { t("h-full") }),
  s("sz ", { t("size-") }),
  s("rn ", { t("ring-") }),
  s("te ", { t("text-") }),
  s("h;", { t("flex items-center gap-2") }),
  s("hb;", { t("flex items-center justify-between gap-2") }),
  s("hb;", { t("flex items-center justify-between gap-2") }),
  s("ex ", { t("export ") }),
  s("edf ", { t("export default function ") }),
  s("fn ", { t("function ") }),
  s("c ", { t("const ") }),
  s("r ", { t("return ") }),
  s("iy ", { t("inset-y- ") }),
  s("ix ", { t("inset-x- ") }),
  s("ec ", { t("export const ") }),
  s("et ", { t("export type ") }),
  s("ei ", { t("export interface ") }),
  s("int ", { t("interface ") }),
  s("aw ", { t("await ") }),
  s("ac ", { t("async ") }),
  s("am ", { t("asyncMap("), i(1), t(")") }),
  s("f ", { t("for ("), i(1), t(")") }),
  s("l ", { t("console.log("), i(1), t(")") }),
  s("ce ", { t("console.error("), i(1), t(")") }),
  s("js ", { t("JSON.stringify("), i(1), t(", null, 2)") }),
  s("jp ", { t("JSON.parse("), i(1), t(")") }),
  s("hd;", { t("hidden") }),
  s("pre ", fmt("<pre>{{JSON.stringify({}, null, 2)}}</pre>", { i(0) })),
  s("dt ", fmt("defineTable({{\n\t{}\n}}),", { i(0) })),
  s("oc ", { t("onClick={() => "), i(1), t("}") }),
  s("os ", { t("onSubmit={(e) => "), i(1), t("}") }),
  s("pd;", { t("e.preventDefault();") }),
  s("sp;", { t("e.stopPropagation();") }),
  s("hs;", fmt("form.handleSubmit({})", { i(0) })),
  s("ff ", fmt('<form.Field\n\tname="{}"\n/>', { i(0) })),
  s("ch ", fmt("children={{(field) => (\n\t{}\n)}}", { i(0) })),
  s("tc ", fmt("try {{\n\t{}\n}} catch (err) {{\n\t{}\n}}", { i(0), i(1) })),
  s("c;", { t("console.log('"), f(clipboard), t(" :>>', "), f(clipboard), t(");") }),
  s("dg ", fmt('<div className="grid gap-2">\n\t{}\n</div>', { i(0) })),
  s("och ", { t("onChange={"), i(1), t("}") }),
  s("oe ", { t("onChange={(e) => "), i(1), t("}") }),
  s("qu ", fmt("query({{\n\t{}\n}})", { i(0) })),
  s("mu ", fmt("mutation({{\n\t{}\n}})", { i(0) })),
  s("iq ", fmt("internalQuery({{\n\t{}\n}})", { i(0) })),
  s("im ", fmt("internalMutation({{\n\t{}\n}})", { i(0) })),
  s("ia ", fmt("internalAction({{\n\t{}\n}})", { i(0) })),
  s("cq ", { t("ctx.db.query("), i(1), t(")") }),
  s("ci ", { t("ctx.db.insert("), i(1), t(")") }),
  s("cp ", { t("ctx.db.patch("), i(1), t(")") }),
  s("cg ", { t("ctx.db.get("), i(1), t(")") }),
  s("rm ", { t("ctx.runMutation("), i(1), t(")") }),
  s("rq ", { t("ctx.runQuery("), i(1), t(")") }),
  s("ra ", { t("ctx.runAction("), i(1), t(")") }),
  s("hd ", fmt("handler: async (ctx) => {{\n\t{}\n}}", { i(0) })),
  s("ha ", fmt("handler: async (ctx, args) => {{\n\t{}\n}}", { i(0) })),
  s("uq ", { t("useQuery("), i(1), t(")") }),
  s("upq ", { t("usePaginatedQuery("), i(1), t(")") }),
  s("um ", { t("useMutation("), i(1), t(")") }),
  s("tn ", { t("throw new Error("), i(1), t(")") }),
  s("u;", { t("const userId = await getAuthUserId(ctx);") }),
  s("r. ", { t("React.") }),
  s("ir;", { t("import * as React from 'react';") }),
  s("cni;", { t("import { cn } from '@/lib/utils';") }),
  s("iz;", { t("import * as z from 'zod';") }),
  s("ue;", { t("React.useEffect(() => {"), i(1), t("}, []);") }),
  s("ue ", { t("useEffect(() => {"), i(1), t("}, []);") }),
  s("uc ", { t("useCallback("), i(1), t(")") }),
  s("cb ", { t("const ["), i(1), t("] = "), i(2) }),
  s("hr ", { t("toast.error("), i(1), t(")") }),
  s("hs ", { t("toast.success("), i(1), t(")") }),
  s("hi ", { t("toast.info("), i(1), t(")") }),
  s("hc ", { t("toast.loading("), i(1), t(")") }),
  s("rp;", { t("Route.useParams()") }),
  s("rn;", { t("const navigate = Route.useNavigate()") }),
  s("rs;", { t("Route.useSearch()") }),
  s("r;", { t("return") }),
  s(
    "cm;",
    fmt(
      [[<Command>
  <CommandInput placeholder="Type a command or search..." />
  <CommandList>
    <CommandEmpty>No results found.</CommandEmpty>
    <CommandGroup heading="Suggestions">
      <CommandItem>Calendar</CommandItem>
      <CommandItem>Search Emoji</CommandItem>
      <CommandItem>Calculator</CommandItem>
    </CommandGroup>
    <CommandSeparator />
    <CommandGroup heading="Settings">
      <CommandItem>Profile</CommandItem>
      <CommandItem>Billing</CommandItem>
      <CommandItem>Settings</CommandItem>
    </CommandGroup>
  </CommandList>
</Command>]],
      {}
    )
  ),
  s("tbi;", { t([[import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";]]) }),
  s(
    "tb;",
    fmt(
      [[<Tabs value={{tab}} onValueChange={{(value) => setTab(value)}}>
  <TabsList>
    <TabsTrigger value="">{}</TabsTrigger>
  </TabsList>
</Tabs>]],
      { i(0) }
    )
  ),
  s(
    "cmi;",
    fmt(
      [[import {{ Command, CommandDialog, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList, CommandSeparator, CommandShortcut }} from "@/components/ui/command"]],
      {}
    )
  ),
  s("t;", {
    f(function()
      return os.date("!%Y-%m-%dT%H:%M:%SZ")
    end),
  }),
  s("eaf ", fmt("export async function {}() {{\n\t{}\n}}", { i(1), i(0) })),
  s("af ", fmt("async function {}() {{\n\t{}\n}}", { i(1), i(0) })),
  s("il;", { t("isLoading") }),
  s("ie;", { t("isError") }),
  s("is;", { t("isSuccess") }),
  s(
    "drag;",
    fmt(
      [[onClick={{() => fileRef.current?.click()}}
      onDragEnter={{(e) => {{
  		e.preventDefault();
  		e.stopPropagation();
  		setIsDragging(true);
  	}}}}
  	onDragLeave={{(e) => {{
  		e.preventDefault();
  		e.stopPropagation();
  		if (e.currentTarget.contains(e.relatedTarget as Node)) {{
  			return;
  		}}
  		setIsDragging(false);
  	}}}}
  	onDragOver={{(e) => {{
  		e.preventDefault();
  		e.stopPropagation();
  	}}}}
  	onDrop={{async (e) => {{
  		e.preventDefault();
  		e.stopPropagation();
  		setIsDragging(false);
  		const files = e.dataTransfer?.files;
  		if (!files || !files.length) return;
  		await handleFileUpload(files[0]);
  	}}}}{}]],
      { i(0) }
    )
  ),
}
