import { useEffect, useMemo, useState } from "react";
import { Check, FileText } from "lucide-react";
import type { ReadingStatus } from "@/lib/api";
import { cn } from "@/lib/utils";

function fallbackFavicon(sourceUrl: string | null): string | null {
  if (!sourceUrl) return null;
  try {
    const url = new URL(sourceUrl);
    return url.protocol === "https:" ? `${url.origin}/favicon.ico` : null;
  } catch {
    return null;
  }
}

const VENUE_ICON_GROUPS = [
  { icon: "/venue-icons/acl.png", aliases: ["ACL", "EMNLP", "NAACL", "EACL", "AACL", "COLING", "CONLL", "TACL", "Association for Computational Linguistics", "Empirical Methods in Natural Language Processing"] },
  { icon: "/venue-icons/neurips.png", aliases: ["NEURIPS", "NIPS", "Neural Information Processing Systems"] },
  { icon: "/venue-icons/icml.png", aliases: ["ICML", "International Conference on Machine Learning"] },
  { icon: "/venue-icons/iclr.png", aliases: ["ICLR", "International Conference on Learning Representations"] },
  { icon: "/venue-icons/cvf.png", aliases: ["CVPR", "ICCV", "ECCV", "WACV", "Computer Vision and Pattern Recognition", "International Conference on Computer Vision", "European Conference on Computer Vision"] },
  { icon: "/venue-icons/aaai.png", aliases: ["AAAI", "Association for the Advancement of Artificial Intelligence"] },
  { icon: "/venue-icons/ijcai.png", aliases: ["IJCAI", "International Joint Conference on Artificial Intelligence"] },
  { icon: "/venue-icons/vldb.png", aliases: ["VLDB", "PVLDB"] },
  { icon: "/venue-icons/usenix.png", aliases: ["OSDI", "NSDI", "FAST", "USENIX ATC", "USENIX SECURITY", "USENIX Symposium", "File and Storage Technologies", "USENIX Annual Technical Conference"] },
  {
    icon: "/venue-icons/acm.png",
    aliases: ["KDD", "SIGIR", "SIGMOD", "SIGCOMM", "MOBICOM", "SOSP", "ASPLOS", "ISCA", "MICRO", "STOC", "CHI", "UIST", "CSCW", "ICSE", "FSE", "ASE", "CCS", "ACM MM", "SIGGRAPH", "TOG", "International Conference on Software Engineering", "Foundations of Software Engineering", "Automated Software Engineering", "Knowledge Discovery and Data Mining", "Management of Data", "Computer and Communications Security", "Human Factors in Computing Systems", "POPL", "PLDI", "OOPSLA", "ICFP", "LCTES", "PPoPP", "PACT", "CGO", "ISSTA", "MSR", "WWW", "WSDM", "CIKM", "ICMR", "RecSys", "PODS", "SoCC", "EuroSys", "MobiSys", "SenSys", "IPSN", "IMC", "SIGMETRICS", "SPAA", "PODC", "TODS", "TOIS", "TOPLAS", "TOSEM", "TOMM", "TOS", "TACO", "CSUR", "PACMPL", "PACMHCI", "PACMMOD", "Programming Language Design and Implementation", "Principles of Programming Languages", "Object-Oriented Programming Systems Languages and Applications", "ACM Computing Surveys", "ACM Transactions"],
  },
  {
    icon: "/venue-icons/ieee.jpg",
    aliases: ["ICDE", "INFOCOM", "HPCA", "IEEE S&P", "IEEE SP", "S&P", "TSE", "TPAMI", "TKDE", "TVCG", "VIS", "VR", "RTSS", "ICDCS", "ICSME", "SANER", "RE", "ESEM", "ISSRE", "ICST", "ICSA", "COMPSAC", "QRS", "ICDCS", "IPDPS", "SC", "CLUSTER", "CCGRID", "ICDM", "ICME", "ICASSP", "ICIP", "ICRA", "IROS", "CDC", "IJCNN", "WCCI", "TNNLS", "TCC", "TC", "TMC", "TDSC", "TSC", "TMM", "TIP", "TSP", "TIT", "TWC", "JSAC", "JSTSP", "RA-L", "IEEE Transactions", "Transactions on Software Engineering", "Transactions on Pattern Analysis and Machine Intelligence", "Transactions on Knowledge and Data Engineering", "Transactions on Visualization and Computer Graphics", "Transactions on Neural Networks and Learning Systems", "Proceedings of the IEEE"],
  },
] as const;

const SOURCE_ICON_GROUPS: Array<[RegExp, string]> = [
  [/(^|\.)aclanthology\.org$/, "/venue-icons/acl.png"],
  [/(^|\.)neurips\.cc$|(^|\.)nips\.cc$/, "/venue-icons/neurips.png"],
  [/(^|\.)icml\.cc$/, "/venue-icons/icml.png"],
  [/(^|\.)iclr\.cc$/, "/venue-icons/iclr.png"],
  [/(^|\.)thecvf\.com$|^openaccess\.thecvf\.com$/, "/venue-icons/cvf.png"],
  [/(^|\.)aaai\.org$/, "/venue-icons/aaai.png"],
  [/(^|\.)ijcai\.org$/, "/venue-icons/ijcai.png"],
  [/(^|\.)vldb\.org$/, "/venue-icons/vldb.png"],
  [/(^|\.)usenix\.org$/, "/venue-icons/usenix.png"],
  [/(^|\.)acm\.org$/, "/venue-icons/acm.png"],
  [/(^|\.)ieee\.org$/, "/venue-icons/ieee.jpg"],
];

function normalizedVenue(value: string): string {
  return value.toUpperCase().replace(/[^A-Z0-9]+/g, " ").trim();
}

function containsVenueAlias(venue: string, alias: string): boolean {
  return ` ${normalizedVenue(venue)} `.includes(` ${normalizedVenue(alias)} `);
}

export function conferenceIcon(venue: string | null, sourceUrl: string | null): string | null {
  if (venue) {
    const group = VENUE_ICON_GROUPS.find(({ aliases }) => aliases.some((alias) => containsVenueAlias(venue, alias)));
    if (group) return group.icon;
  }
  let sourceHost = "";
  try { sourceHost = sourceUrl ? new URL(sourceUrl).hostname.toLowerCase() : ""; } catch { /* fall through */ }
  return SOURCE_ICON_GROUPS.find(([pattern]) => pattern.test(sourceHost))?.[1] ?? null;
}

export function VenueBadge({ venue, sourceUrl, iconUrl, compact = false, status }: { venue: string | null; sourceUrl?: string | null; iconUrl?: string | null; compact?: boolean; status?: ReadingStatus }) {
  const candidates = useMemo(() => {
    const brand = conferenceIcon(venue, sourceUrl ?? null);
    // A captured event logo is more specific than a generic publisher logo.
    const publisher = brand && /\/(acm|ieee|usenix)\./.test(brand);
    const urls = publisher ? [iconUrl, brand] : [brand, iconUrl];
    return [...new Set([...urls, fallbackFavicon(sourceUrl ?? null)].filter((url): url is string => Boolean(url)))];
  }, [venue, iconUrl, sourceUrl]);
  const [candidateIndex, setCandidateIndex] = useState(0);
  useEffect(() => setCandidateIndex(0), [candidates.join("|")]);
  const src = candidates[candidateIndex] ?? null;
  let sourceHost: string | null = null;
  try { sourceHost = sourceUrl ? new URL(sourceUrl).hostname : null; } catch { /* fall through */ }
  return (
    <span title={venue || sourceHost || "未识别来源网站"} className={cn(compact ? "h-7 w-7" : "h-8 w-8", "relative flex shrink-0 items-center justify-center rounded-lg border bg-white dark:bg-zp-surface", status === "unread" ? "border-zp-tertiary" : "border-zp-border")}>
      {src ? <img src={src} alt="" className={cn(compact ? "h-4 w-4" : "h-[18px] w-[18px]", "object-contain")} onError={() => setCandidateIndex((index) => index + 1)} /> : <FileText className={cn(compact ? "h-3.5 w-3.5" : "h-4 w-4", "text-zp-quaternary")} />}
      <StatusMark status={status} />
    </span>
  );
}

function StatusMark({ status }: { status?: ReadingStatus }) {
  if (!status) return null;
  if (status === "read") {
    return <span className="absolute -bottom-1 -right-1 flex h-3.5 w-3.5 items-center justify-center rounded-full border border-white bg-zp-tertiary text-white dark:border-zp-surface"><Check className="h-2.5 w-2.5" strokeWidth={3} /></span>;
  }
  return <span className={cn("absolute -bottom-0.5 -right-0.5 h-2 w-2 rounded-full border border-white dark:border-zp-surface", status === "unread" ? "bg-zp-primary" : "bg-amber-500")} />;
}
