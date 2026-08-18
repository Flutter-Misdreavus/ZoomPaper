import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import type { Conversation } from "@/lib/api";

interface Props {
  conversation: Conversation | null;
  deleting: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

/** 删除会话确认弹窗（阅读页问答栏与 AskPage 共用） */
export function ConversationDeleteDialog({
  conversation,
  deleting,
  onConfirm,
  onCancel,
}: Props) {
  return (
    <AlertDialog open={conversation != null} onOpenChange={(open) => !open && onCancel()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>删除会话</AlertDialogTitle>
          <AlertDialogDescription>
            将删除「{conversation?.title || "未命名会话"}」及其全部消息，无法恢复。
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={deleting}>取消</AlertDialogCancel>
          <AlertDialogAction
            disabled={deleting}
            onClick={() => onConfirm()}
            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
          >
            {deleting ? "删除中…" : "删除"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
