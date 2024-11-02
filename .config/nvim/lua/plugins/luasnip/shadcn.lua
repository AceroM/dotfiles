local ls = require("luasnip")
local s = ls.snippet
local t = ls.text_node
local i = ls.insert_node
local fmt = require("luasnip.extras.fmt").fmt

return {
	s(
		{ trig = "sf;", name = "shadcn form" },
		fmt(
			"<Form {{...form}}>\n\t<form onSubmit={{form.handleSubmit(onSubmit)}}>\n\t\t{}\n\t</form>\n</Form>",
			{ i(0) }
		)
	),
	s(
		{ trig = "sff;", name = "shadcn form field" },
		fmt(
			[[
<FormField
  control={{form.control}}
  name="{}"
  render={{({{ field, fieldState }}) => (
    <FormItem>
      <FormLabel>{}</FormLabel>
      <FormControl>
        <Input
          placeholder="{}"
          {{...field}}
          disabled={{isSubmitting}}
          error={{fieldState.error?.message}}
        />
      </FormControl>
      <FormDescription>{}</FormDescription>
    </FormItem>
  )}}
/>
			]],
			{ i(1, "fieldName"), i(2, "Label"), i(3, "placeholder"), i(4, "Description") }
		)
	),
	s("dl;", { t("<DashboardLayout>"), i(1), t("</DashboardLayout>") }),
	s("dh;", { t("<DashboardHeader>"), i(1), t("</DashboardHeader>") }),
	s("dc;", { t("<DashboardContent>"), i(1), t("</DashboardContent>") }),
	s("ac;", { t("<Accordion>"), i(1), t("</Accordion>") }),
	s("acc;", { t("<AccordionContent>"), i(1), t("</AccordionContent>") }),
	s("aci;", { t("<AccordionItem>"), i(1), t("</AccordionItem>") }),
	s("acg;", { t("<AccordionTrigger>"), i(1), t("</AccordionTrigger>") }),
	s("n;", { t("<Note>"), i(1), t("</Note>") }),
	s("al;", { t("<Alert>"), i(1), t("</Alert>") }),
	s("ald;", { t("<AlertDescription>"), i(1), t("</AlertDescription>") }),
	s("alt;", { t("<AlertTitle>"), i(1), t("</AlertTitle>") }),
	s("sk;", { t('<Skeleton className="'), i(1), t('" />') }),
	s("sa;", { t("<ScrollArea>"), i(1), t("</ScrollArea>") }),
	s("sp;", { t("<Separator "), i(1), t(" />") }),
	s("sd;", { t("<Slider "), i(1), t(" />") }),
	s("sw;", { t("<Switch "), i(1), t(" />") }),
	s("sh;", { t("<Sheet>"), i(1), t("</Sheet>") }),
	s("shx;", { t("<SheetClose>"), i(1), t("</SheetClose>") }),
	s("shc;", { t("<SheetContent>"), i(1), t("</SheetContent>") }),
	s("shd;", { t("<SheetDescription>"), i(1), t("</SheetDescription>") }),
	s("shf;", { t("<SheetFooter>"), i(1), t("</SheetFooter>") }),
	s("shh;", { t("<SheetHeader>"), i(1), t("</SheetHeader>") }),
	s("sht;", { t("<SheetTitle>"), i(1), t("</SheetTitle>") }),
	s("shg;", { t("<SheetTrigger>"), i(1), t("</SheetTrigger>") }),
	s("sb;", { t("<Sidebar>"), i(1), t("</Sidebar>") }),
	s("sbc;", { t("<SidebarContent>"), i(1), t("</SidebarContent>") }),
	s("sbf;", { t("<SidebarFooter>"), i(1), t("</SidebarFooter>") }),
	s("sbgr;", { t("<SidebarGroup>"), i(1), t("</SidebarGroup>") }),
	s("sbgrc;", { t("<SidebarGroupContent>"), i(1), t("</SidebarGroupContent>") }),
	s("sbh;", { t("<SidebarHeader>"), i(1), t("</SidebarHeader>") }),
	s("sbin;", { t("<SidebarInset>"), i(1), t("</SidebarInset>") }),
	s("sbm;", { t("<SidebarMenu>"), i(1), t("</SidebarMenu>") }),
	s("sbmb;", { t("<SidebarMenuButton>"), i(1), t("</SidebarMenuButton>") }),
	s("sbmi;", { t("<SidebarMenuItem>"), i(1), t("</SidebarMenuItem>") }),
	s("sbp;", { t("<SidebarProvider>"), i(1), t("</SidebarProvider>") }),
	s("sbg;", { t("<SidebarTrigger>"), i(1), t("</SidebarTrigger>") }),
	s("s;", { t("<Select>"), i(1), t("</Select>") }),
	s("sg;", { t("<SelectTrigger>"), i(1), t("</SelectTrigger>") }),
	s("sl;", { t("<SelectLabel>"), i(1), t("</SelectLabel>") }),
	s("sv;", { t("<SelectValue "), i(1), t(" />") }),
	s("sgr;", { t("<SelectGroup>"), i(1), t("</SelectGroup>") }),
	s("sc;", { t("<SelectContent>"), i(1), t("</SelectContent>") }),
	s("si;", { t("<SelectItem>"), i(1), t("</SelectItem>") }),
	s("pa;", { t("<Pagination>"), i(1), t("</Pagination>") }),
	s("pac;", { t("<PaginationContent>"), i(1), t("</PaginationContent>") }),
	s("pai;", { t("<PaginationItem>"), i(1), t("</PaginationItem>") }),
	s("pak;", { t("<PaginationLink>"), i(1), t("</PaginationLink>") }),
	s("pan;", { t("<PaginationNext>"), i(1), t("</PaginationNext>") }),
	s("pap;", { t("<PaginationPrevious>"), i(1), t("</PaginationPrevious>") }),
	s("pae;", { t("<PaginationEllipsis>"), i(1), t("</PaginationEllipsis>") }),
	s("pr;", { t("<Progress "), i(1), t(" />") }),
	s("p;", { t("<Popover>"), i(1), t("</Popover>") }),
	s("pc;", { t("<PopoverContent>"), i(1), t("</PopoverContent>") }),
	s("pg;", { t("<PopoverTrigger>"), i(1), t("</PopoverTrigger>") }),
	s("sc;", { t("<SelectContent>"), i(1), t("</SelectContent>") }),
	s("si;", { t("<SelectItem>"), i(1), t("</SelectItem>") }),
	s("sg;", { t("<SelectTrigger>"), i(1), t("</SelectTrigger>") }),
	s("sv;", { t("<SelectValue>"), i(1), t("</SelectValue>") }),
	s("b;", { t("<Button>"), i(1), t("</Button>") }),
	s("ba;", { t("<Badge>"), i(1), t("</Badge>") }),
	s("bc;", { t("<Breadcrumb>"), i(1), t("</Breadcrumb>") }),
	s("bcs;", { t("<BreadcrumbSeparator />") }),
	s("bce;", { t('<BreadcrumbEllipsis className="h-4 w-4" />') }),
	s("bcl;", { t("<BreadcrumbList>"), i(1), t("</BreadcrumbList>") }),
	s("bci;", { t("<BreadcrumbItem>"), i(1), t("</BreadcrumbItem>") }),
	s("bck;", { t("<BreadcrumbLink>"), i(1), t("</BreadcrumbLink>") }),
	s("bcp;", { t("<BreadcrumbPage>"), i(1), t("</BreadcrumbPage>") }),
	s("cl;", { t("<Collapsible>"), i(1), t("</Collapsible>") }),
	s("clg;", { t("<CollapsibleTrigger>"), i(1), t("</CollapsibleTrigger>") }),
	s("clc;", { t("<CollapsibleContent>"), i(1), t("</CollapsibleContent>") }),
	s("ca;", { t("<Carousel>"), i(1), t("</Carousel>") }),
	s("cd;", { t("<Command>"), i(1), t("</Command>") }),
	s("cdin;", { t("<CommandInput "), i(1), t(" />") }),
	s("cdl;", { t("<CommandList>"), i(1), t("</CommandList>") }),
	s("cde;", { t("<CommandEmpty>"), i(1), t("</CommandEmpty>") }),
	s("cdgr;", { t("<CommandGroup>"), i(1), t("</CommandGroup>") }),
	s("cdi;", { t("<CommandItem>"), i(1), t("</CommandItem>") }),
	s("cds;", { t("<CommandSeparator "), i(1), t(" />") }),
	s("cdsh;", { t("<CommandShortcut>"), i(1), t("</CommandShortcut>") }),
	s("cm;", { t("<ContextMenu>"), i(1), t("</ContextMenu>") }),
	s("cmg;", { t("<ContextMenuTrigger>"), i(1), t("</ContextMenuTrigger>") }),
	s("cmc;", { t("<ContextMenuContent>"), i(1), t("</ContextMenuContent>") }),
	s("cmi;", { t("<ContextMenuItem>"), i(1), t("</ContextMenuItem>") }),
	s("cmk;", { t("<ContextMenuCheckboxItem>"), i(1), t("</ContextMenuCheckboxItem>") }),
	s("cmr;", { t("<ContextMenuRadioItem>"), i(1), t("</ContextMenuRadioItem>") }),
	s("cml;", { t("<ContextMenuLabel>"), i(1), t("</ContextMenuLabel>") }),
	s("cms;", { t("<ContextMenuSeparator>"), i(1), t("</ContextMenuSeparator>") }),
	s("cmsh;", { t("<ContextMenuShortcut>"), i(1), t("</ContextMenuShortcut>") }),
	s("cmsu;", { t("<ContextMenuSub>"), i(1), t("</ContextMenuSub>") }),
	s("cmsg;", { t("<ContextMenuSubTrigger>"), i(1), t("</ContextMenuSubTrigger>") }),
	s("cmsc;", { t("<ContextMenuSubContent>"), i(1), t("</ContextMenuSubContent>") }),
	s("cmgr;", { t("<ContextMenuGroup>"), i(1), t("</ContextMenuGroup>") }),
	s("cmrg;", { t("<ContextMenuRadioGroup>"), i(1), t("</ContextMenuRadioGroup>") }),
	s("cac;", { t("<CarouselContent>"), i(1), t("</CarouselContent>") }),
	s("cai;", { t("<CarouselItem>"), i(1), t("</CarouselItem>") }),
	s("can;", { t("<CarouselNext>"), i(1), t("</CarouselNext>") }),
	s("cap;", { t("<CarouselPrevious>"), i(1), t("</CarouselPrevious>") }),
	s("c;", { t("<Card>"), i(1), t("</Card>") }),
	s("ct;", { t("<CardTitle>"), i(1), t("</CardTitle>") }),
	s("ch;", { t("<CardHeader>"), i(1), t("</CardHeader>") }),
	s("cd;", { t("<CardDescription>"), i(1), t("</CardDescription>") }),
	s("cc;", { t("<CardContent>"), i(1), t("</CardContent>") }),
	s("cf;", { t("<CardFooter>"), i(1), t("</CardFooter>") }),
	s("tt;", { t("<Tooltip>"), i(1), t("</Tooltip>") }),
	s("ttc;", { t("<TooltipContent>"), i(1), t("</TooltipContent>") }),
	s("ttg;", { t("<TooltipTrigger>"), i(1), t("</TooltipTrigger>") }),
	s("ttp;", { t("<TooltipProvider>"), i(1), t("</TooltipProvider>") }),
	s("tb;", { t("<Tabs>"), i(1), t("</Tabs>") }),
	s("tbc;", { t("<TabsContent>"), i(1), t("</TabsContent>") }),
	s("tbl;", { t("<TabsList>"), i(1), t("</TabsList>") }),
	s("tbg;", { t("<TabsTrigger>"), i(1), t("</TabsTrigger>") }),
	s("t;", { t("<Table>"), i(1), t("</Table>") }),
	s("tbd;", { t("<TableBody>"), i(1), t("</TableBody>") }),
	s("tw;", { t("<TableRow>"), i(1), t("</TableRow>") }),
	s("ti;", { t("<TableCell>"), i(1), t("</TableCell>") }),
	s("th;", { t("<TableHead>"), i(1), t("</TableHead>") }),
	s("thr;", { t("<TableHeader>"), i(1), t("</TableHeader>") }),
	s("l;", { t("<Link>"), i(1), t("</Link>") }),
	s("lb;", { t("<Label>"), i(1), t("</Label>") }),
	s("ta;", { t("<Textarea "), i(1), t(" />") }),
	s("tg;", { t("<Toggle>"), i(1), t("</Toggle>") }),
	s("tgg;", { t("<ToggleGroup>"), i(1), t("</ToggleGroup>") }),
	s("tgi;", { t("<ToggleGroupItem>"), i(1), t("</ToggleGroupItem>") }),
	s("i;", { t("<Input "), i(1), t(" />") }),
	s("otp;", { t("<InputOtp>"), i(1), t("</InputOtp>") }),
	s("otpg;", { t("<InputOtpGroup>"), i(1), t("</InputOtpGroup>") }),
	s("otpi;", { t("<InputOtpSlot "), i(1), t(" />") }),
	s("otps;", { t("<InputOtpSeparator />") }),
	s("cb;", { t('<Checkbox id="'), i(1), t('" />') }),
	s("hd;", { t("<Heading>"), i(1), t("</Heading>") }),
	s("m;", { t("<Modal>"), i(1), t("</Modal>") }),
	s("hc;", { t("<HoverCard>"), i(1), t("</HoverCard>") }),
	s("hcc;", { t("<HoverCardContent>"), i(1), t("</HoverCardContent>") }),
	s("hcg;", { t("<HoverCardTrigger>"), i(1), t("</HoverCardTrigger>") }),
	s("dr;", { t("<Drawer>"), i(1), t("</Drawer>") }),
	s("drx;", { t("<DrawerClose>"), i(1), t("</DrawerClose>") }),
	s("drc;", { t("<DrawerContent>"), i(1), t("</DrawerContent>") }),
	s("drc;", { t("<DrawerDescription>"), i(1), t("</DrawerDescription>") }),
	s("drh;", { t("<DrawerHeader>"), i(1), t("</DrawerHeader>") }),
	s("drf;", { t("<DrawerFooter>"), i(1), t("</DrawerFooter>") }),
	s("drt;", { t("<DrawerTitle>"), i(1), t("</DrawerTitle>") }),
	s("drg;", { t("<DrawerTrigger>"), i(1), t("</DrawerTrigger>") }),
	s("ad;", { t("<AlertDialog>"), i(1), t("</AlertDialog>") }),
	s("ada;", { t("<AlertDialogAction>"), i(1), t("</AlertDialogAction>") }),
	s("adx;", { t("<AlertDialogCancel>"), i(1), t("</AlertDialogCancel>") }),
	s("adc;", { t("<AlertDialogContent>"), i(1), t("</AlertDialogContent>") }),
	s("add;", { t("<AlertDialogDescription>"), i(1), t("</AlertDialogDescription>") }),
	s("adf;", { t("<AlertDialogFooter>"), i(1), t("</AlertDialogFooter>") }),
	s("adh;", { t("<AlertDialogHeader>"), i(1), t("</AlertDialogHeader>") }),
	s("adt;", { t("<AlertDialogTitle>"), i(1), t("</AlertDialogTitle>") }),
	s("adg;", { t("<AlertDialogTrigger>"), i(1), t("</AlertDialogTrigger>") }),
	s("di;", { t("<Dialog>"), i(1), t("</Dialog>") }),
	s("dig;", { t("<DialogTrigger>"), i(1), t("</DialogTrigger>") }),
	s("dic;", { t("<DialogContent>"), i(1), t("</DialogContent>") }),
	s("dit;", { t("<DialogTitle>"), i(1), t("</DialogTitle>") }),
	s("did;", { t("<DialogDescription>"), i(1), t("</DialogDescription>") }),
	s("dif;", { t("<DialogFooter>"), i(1), t("</DialogFooter>") }),
	s("dih;", { t("<DialogHeader>"), i(1), t("</DialogHeader>") }),
	s("dm;", { t("<DropdownMenu>"), i(1), t("</DropdownMenu>") }),
	s("dmg;", { t("<DropdownMenuTrigger>"), i(1), t("</DropdownMenuTrigger>") }),
	s("dms;", { t("<DropdownMenuSeparator>"), i(1), t("</DropdownMenuSeparator>") }),
	s("dmc;", { t("<DropdownMenuContent>"), i(1), t("</DropdownMenuContent>") }),
	s("dml;", { t("<DropdownMenuLabel>"), i(1), t("</DropdownMenuLabel>") }),
	s("dmi;", { t("<DropdownMenuItem>"), i(1), t("</DropdownMenuItem>") }),
	s("dmci;", { t("<DropdownMenuCheckboxItem>"), i(1), t("</DropdownMenuCheckboxItem>") }),
	s("dmrg;", { t("<DropdownMenuRadioGroup>"), i(1), t("</DropdownMenuRadioGroup>") }),
	s("dmri;", { t("<DropdownMenuRadioItem>"), i(1), t("</DropdownMenuRadioItem>") }),
	s("mb;", { t("<Menubar>"), i(1), t("</Menubar>") }),
	s("mbci;", { t("<MenubarCheckboxItem>"), i(1), t("</MenubarCheckboxItem>") }),
	s("mbg;", { t("<MenubarTrigger>"), i(1), t("</MenubarTrigger>") }),
	s("mbc;", { t("<MenubarContent>"), i(1), t("</MenubarContent>") }),
	s("mbi;", { t("<MenubarItem>"), i(1), t("</MenubarItem>") }),
	s("mbm;", { t("<MenubarMenu>"), i(1), t("</MenubarMenu>") }),
	s("mbrg;", { t("<MenubarRadioGroup>"), i(1), t("</MenubarRadioGroup>") }),
	s("mbri;", { t("<MenubarRadioItem>"), i(1), t("</MenubarRadioItem>") }),
	s("mbs;", { t("<MenubarSeparator />") }),
	s("mbsc;", { t("<MenubarShortcut>"), i(1), t("</MenubarShortcut>") }),
	s("mbsub;", { t("<MenubarSub>"), i(1), t("</MenubarSub>") }),
	s("mbsubrc;", { t("<MenubarSubContent>"), i(1), t("</MenubarSubContent>") }),
	s("mbsubri;", { t("<MenubarSubItem>"), i(1), t("</MenubarSubItem>") }),
	s("nm;", { t("<NavigationMenu>"), i(1), t("</NavigationMenu>") }),
	s("nmc;", { t("<NavigationMenuContent>"), i(1), t("</NavigationMenuContent>") }),
	s("nmi;", { t("<NavigationMenuItem>"), i(1), t("</NavigationMenuItem>") }),
	s("nmk;", { t("<NavigationMenuLink>"), i(1), t("</NavigationMenuLink>") }),
	s("nml;", { t("<NavigationMenuList>"), i(1), t("</NavigationMenuList>") }),
	s("nmt;", { t("<NavigationTrigger>"), i(1), t("</NavigationTrigger>") }),
	s("nmts;", { t("<NavigationTriggerStyle>"), i(1), t("</NavigationTriggerStyle>") }),
	s("rg;", { t("<RadioGroup>"), i(1), t("</RadioGroup>") }),
	s("rgi;", { t("<RadioGroupItem>"), i(1), t("</RadioGroupItem>") }),
	s("rh;", { t("<ResizableHandle />") }),
	s("rp;", { t("<ResizablePanel>"), i(1), t("</ResizablePanel>") }),
	s("rpg;", { t("<ResizablePanelGroup>"), i(1), t("</ResizablePanelGroup>") }),
}