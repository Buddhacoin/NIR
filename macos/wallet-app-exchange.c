#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <string.h>

// macOS-only, same-volume atomic exchange. The caller has already validated
// both app bundles and keeps the old one at the staging path after success.
int main(int argc, char **argv) {
    if (argc != 3) {
        fputs("usage: wallet-app-exchange old.app staged.app\n", stderr);
        return 2;
    }
    if (renameatx_np(AT_FDCWD, argv[1], AT_FDCWD, argv[2], RENAME_SWAP) != 0) {
        fprintf(stderr, "atomic wallet exchange failed: %s\n", strerror(errno));
        return 1;
    }
    return 0;
}
