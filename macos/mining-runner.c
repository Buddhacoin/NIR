#include <stdio.h>
#include <signal.h>
#include <errno.h>
#include <sys/wait.h>
#include <unistd.h>

static volatile sig_atomic_t stop_requested = 0;
static void request_stop(int signal_number) {
    (void)signal_number;
    stop_requested = 1;
}

// This supervisor stays the group leader while Node and Python are alive.
// Keeping the group ID occupied avoids signaling a recycled ID after a Node
// crash. It owns a bounded TERM -> KILL cleanup, including grandchildren.
int main(int argc, char **argv) {
    if (argc != 4 || setpgid(0, 0) != 0) {
        fputs("NIR model runner initialization failed\n", stderr);
        return 1;
    }
    struct sigaction action = {0};
    action.sa_handler = request_stop;
    sigemptyset(&action.sa_mask);
    if (sigaction(SIGTERM, &action, NULL) != 0) return 1;
    pid_t child = fork();
    if (child < 0) return 1;
    if (child == 0) {
        signal(SIGTERM, SIG_DFL);
        char *const args[] = {argv[1], argv[2], argv[3], NULL};
        execv(argv[1], args);
        perror("NIR model runtime failed");
        _exit(1);
    }
    for (;;) {
        pid_t ended = waitpid(child, NULL, WNOHANG);
        if (ended == child || ended == -1 || stop_requested) break;
        usleep(50000);
    }
    signal(SIGTERM, SIG_IGN);
    kill(-getpgrp(), SIGTERM);
    for (int attempt = 0; attempt < 20; attempt++) {
        pid_t ended = waitpid(child, NULL, WNOHANG);
        if (ended == child || (ended < 0 && errno == ECHILD)) break;
        usleep(50000);
    }
    // The supervisor is still in this group, so its ID cannot have been
    // recycled. A remaining descendant gets a hard stop.
    kill(-getpgrp(), SIGKILL);
    return 1;
}
