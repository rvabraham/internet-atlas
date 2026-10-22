import { HugeiconsIcon, type HugeiconsProps } from '@hugeicons/react';
import { ArrowDown02Icon, ArrowRight02Icon, ArrowUp02Icon, ArrowDown01Icon, ArrowRight01Icon, Tick02Icon, HelpCircleIcon, Copy01Icon, Download04Icon, LinkSquare02Icon, FocusPointIcon, GitBranchIcon, Globe02Icon, Layers01Icon, Loading03Icon, Maximize01Icon, Message01Icon, Remove01Icon, SidebarRight01Icon, PinIcon, Add01Icon, RefreshIcon, Search01Icon, Settings02Icon, SentIcon, StopIcon, UserGroupIcon, Cancel01Icon } from '@hugeicons/core-free-icons';

type IconProps = Omit<HugeiconsProps, 'icon'>;
const icon = (data: NonNullable<HugeiconsProps['icon']>) => function Icon(props: IconProps) { return <HugeiconsIcon icon={data} size={16} strokeWidth={1.5} aria-hidden="true" {...props}/>; };
export const ArrowDown = icon(ArrowDown02Icon), ArrowRight = icon(ArrowRight02Icon), ArrowUp = icon(ArrowUp02Icon);
export const ChevronDown = icon(ArrowDown01Icon), ChevronRight = icon(ArrowRight01Icon), Check = icon(Tick02Icon);
export const CircleHelp = icon(HelpCircleIcon), Copy = icon(Copy01Icon), Download = icon(Download04Icon), ExternalLink = icon(LinkSquare02Icon);
export const Focus = icon(FocusPointIcon), GitBranch = icon(GitBranchIcon), Globe2 = icon(Globe02Icon), Layers2 = icon(Layers01Icon);
export const Loader2 = icon(Loading03Icon), Maximize2 = icon(Maximize01Icon), MessageCircle = icon(Message01Icon), Minus = icon(Remove01Icon);
export const PanelRightClose = icon(SidebarRight01Icon), Pin = icon(PinIcon), Plus = icon(Add01Icon), RefreshCw = icon(RefreshIcon);
export const Search = icon(Search01Icon), SlidersHorizontal = icon(Settings02Icon), Send = icon(SentIcon), Square = icon(StopIcon), Users = icon(UserGroupIcon), X = icon(Cancel01Icon);
