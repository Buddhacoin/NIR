#include <stdio.h>
#include <unistd.h>

// The native app owns this process group. Terminating the app stops the local
// service and any setup/pairing children without leaving an orphaned signer.
int main(int argc, char **argv) {
    if (argc != 3 || setpgid(0, 0) != 0) {
        fputs("NIR wallet runner initialization failed\n", stderr);
        return 1;
    }
    char *const args[] = {argv[1], argv[2], NULL};
    execv(argv[1], args);
    perror("NIR wallet runtime failed");
    return 1;
}
