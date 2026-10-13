#include <CommonCrypto/CommonDigest.h>
#include <fcntl.h>
#include <stdio.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/wait.h>
#include <unistd.h>

static int verifies_closure(const char *verifier, const char *configuration) {
    if (!verifier || !configuration) return 0;
    pid_t child = fork();
    if (child < 0) return 0;
    if (child == 0) {
        char *const args[] = {(char *)verifier, (char *)configuration, NULL};
        execv(verifier, args);
        _exit(127);
    }
    int status = 0;
    if (waitpid(child, &status, 0) != child) return 0;
    return WIFEXITED(status) && WEXITSTATUS(status) == 0;
}

// Fail before starting Node if the executable outside this local .app changed.
// The separate verifier checks the dynamic-library closure first. Neither
// check authenticates a publisher or closes the final path-to-exec race.
static int matches_pin(const char *path, const char *expected) {
    if (!path || !expected || strlen(expected) != CC_SHA256_DIGEST_LENGTH * 2) return 0;
    int fd = open(path, O_RDONLY | O_NOFOLLOW);
    if (fd < 0) return 0;
    struct stat before, after;
    int valid = fstat(fd, &before) == 0 && S_ISREG(before.st_mode) &&
        before.st_size > 0 && before.st_size <= 256 * 1024 * 1024;
    CC_SHA256_CTX context;
    if (valid) valid = CC_SHA256_Init(&context) == 1;
    unsigned char buffer[65536];
    ssize_t count;
    off_t total = 0;
    while (valid && (count = read(fd, buffer, sizeof(buffer))) > 0) {
        total += count;
        valid = total <= before.st_size && CC_SHA256_Update(&context, buffer, (CC_LONG)count) == 1;
    }
    if (valid) valid = count == 0 && total == before.st_size &&
        fstat(fd, &after) == 0 && before.st_dev == after.st_dev &&
        before.st_ino == after.st_ino && before.st_size == after.st_size &&
        before.st_mtimespec.tv_sec == after.st_mtimespec.tv_sec &&
        before.st_mtimespec.tv_nsec == after.st_mtimespec.tv_nsec;
    unsigned char digest[CC_SHA256_DIGEST_LENGTH];
    if (valid) valid = CC_SHA256_Final(digest, &context) == 1;
    close(fd);
    if (!valid) return 0;
    static const char digits[] = "0123456789abcdef";
    char actual[CC_SHA256_DIGEST_LENGTH * 2 + 1];
    for (size_t i = 0; i < CC_SHA256_DIGEST_LENGTH; ++i) {
        actual[2 * i] = digits[digest[i] >> 4];
        actual[2 * i + 1] = digits[digest[i] & 15];
    }
    actual[sizeof(actual) - 1] = '\0';
    return strcmp(actual, expected) == 0;
}

// The native app owns this process group. Terminating the app stops the local
// service and any setup/pairing children without leaving an orphaned signer.
int main(int argc, char **argv) {
    int setup_child = (argc == 7 && strcmp(argv[6], "--child-setup") == 0) ||
        (argc == 8 && strcmp(argv[6], "--child-setup") == 0 &&
         strcmp(argv[7], "--create-only") == 0);
    if ((argc != 6 && !setup_child) ||
        (!setup_child && setpgid(0, 0) != 0) || !verifies_closure(argv[4], argv[5]) ||
        !matches_pin(argv[1], argv[3])) {
        fputs("NIR wallet runner initialization failed\n", stderr);
        return 1;
    }
    char *const args[] = {argv[1], argv[2], argc == 8 ? argv[7] : NULL, NULL};
    execv(argv[1], args);
    perror("NIR wallet runtime failed");
    return 1;
}
