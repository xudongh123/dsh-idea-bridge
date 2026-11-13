package dshbridge;

import com.google.gson.JsonObject;
import com.intellij.notification.NotificationType;
import com.intellij.openapi.actionSystem.ActionUpdateThread;
import com.intellij.openapi.actionSystem.AnAction;
import com.intellij.openapi.actionSystem.AnActionEvent;
import com.intellij.openapi.actionSystem.CommonDataKeys;
import com.intellij.openapi.application.ApplicationManager;
import com.intellij.openapi.project.Project;
import com.intellij.openapi.vfs.VirtualFile;
import org.jetbrains.annotations.NotNull;

import java.util.List;

/**
 * Sends the whole current file to a running DSH session as an {@code @} reference.
 *
 * <p>No selection is needed: the reference names the file, and the model reads
 * whatever part of it the conversation actually needs. Works from the editor
 * and from the project tree.
 */
public final class SendFileToDshAction extends AnAction {

    @Override
    public @NotNull ActionUpdateThread getActionUpdateThread() {
        return ActionUpdateThread.BGT;
    }

    @Override
    public void update(@NotNull AnActionEvent event) {
        VirtualFile file = event.getData(CommonDataKeys.VIRTUAL_FILE);
        event.getPresentation().setEnabledAndVisible(file != null && !file.isDirectory());
    }

    @Override
    public void actionPerformed(@NotNull AnActionEvent event) {
        Project project = event.getProject();
        VirtualFile file = event.getData(CommonDataKeys.VIRTUAL_FILE);
        if (project == null || file == null || file.isDirectory()) {
            return;
        }
        String path = file.getPath();
        String basePath = project.getBasePath();

        ApplicationManager.getApplication().executeOnPooledThread(() -> {
            try {
                String origin = Bridge.readOrigin();
                List<Bridge.Session> sessions = Bridge.fetchSessions(origin);
                Bridge.Session session = Bridge.chooseSession(project, sessions, basePath, "选择要接收整个文件的 DSH 会话：");
                if (session == null) {
                    return;
                }
                JsonObject payload = new JsonObject();
                payload.addProperty("sessionId", session.id());
                payload.addProperty("file", path);
                Bridge.post(origin, "/dsh-idea/card", payload);
                Bridge.notify(project, "已把整个文件放进 DSH 输入框",
                        Bridge.label(session) + "\n" + path, NotificationType.INFORMATION);
            } catch (Exception failure) {
                Bridge.notify(project, "引用整个文件失败", String.valueOf(failure.getMessage()),
                        NotificationType.ERROR);
            }
        });
    }
}
