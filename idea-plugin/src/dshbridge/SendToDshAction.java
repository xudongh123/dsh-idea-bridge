package dshbridge;

import com.google.gson.JsonObject;
import com.intellij.notification.NotificationType;
import com.intellij.openapi.actionSystem.ActionUpdateThread;
import com.intellij.openapi.actionSystem.AnAction;
import com.intellij.openapi.actionSystem.AnActionEvent;
import com.intellij.openapi.actionSystem.CommonDataKeys;
import com.intellij.openapi.application.ApplicationManager;
import com.intellij.openapi.editor.Document;
import com.intellij.openapi.editor.Editor;
import com.intellij.openapi.editor.SelectionModel;
import com.intellij.openapi.project.Project;
import com.intellij.openapi.vfs.VirtualFile;
import org.jetbrains.annotations.NotNull;

import java.util.List;

/**
 * Sends the current editor selection to a running DSH session, as a reference
 * chip parked in that session's composer.
 */
public final class SendToDshAction extends AnAction {

    @Override
    public @NotNull ActionUpdateThread getActionUpdateThread() {
        return ActionUpdateThread.BGT;
    }

    @Override
    public void update(@NotNull AnActionEvent event) {
        Editor editor = event.getData(CommonDataKeys.EDITOR);
        String selected = editor == null ? null : editor.getSelectionModel().getSelectedText();
        boolean hasSelection = selected != null && !selected.isBlank();
        event.getPresentation().setEnabledAndVisible(hasSelection);
    }

    @Override
    public void actionPerformed(@NotNull AnActionEvent event) {
        Project project = event.getProject();
        Editor editor = event.getData(CommonDataKeys.EDITOR);
        VirtualFile file = event.getData(CommonDataKeys.VIRTUAL_FILE);
        if (project == null || editor == null || file == null) {
            return;
        }

        SelectionModel selection = editor.getSelectionModel();
        String text = selection.getSelectedText();
        if (text == null || text.isBlank()) {
            return;
        }

        Document document = editor.getDocument();
        int startLine = document.getLineNumber(selection.getSelectionStart()) + 1;
        int endLine = document.getLineNumber(selection.getSelectionEnd()) + 1;
        String path = file.getPath();
        String basePath = project.getBasePath();

        ApplicationManager.getApplication().executeOnPooledThread(() -> {
            try {
                String origin = Bridge.readOrigin();
                List<Bridge.Session> sessions = Bridge.fetchSessions(origin);
                Bridge.Session session = Bridge.chooseSession(project, sessions, basePath, "选择要接收选区的 DSH 会话：");
                if (session == null) {
                    return;
                }
                JsonObject payload = new JsonObject();
                payload.addProperty("sessionId", session.id());
                payload.addProperty("text", text);
                payload.addProperty("file", path);
                payload.addProperty("line", startLine);
                payload.addProperty("endLine", endLine);
                Bridge.post(origin, "/dsh-idea/draft", payload);
                Bridge.notify(project, "已放入 DSH 输入框",
                        Bridge.label(session) + "\n" + path + ":" + startLine + "-" + endLine,
                        NotificationType.INFORMATION);
            } catch (Exception failure) {
                Bridge.notify(project, "发送到 DSH 失败", String.valueOf(failure.getMessage()),
                        NotificationType.ERROR);
            }
        });
    }
}
