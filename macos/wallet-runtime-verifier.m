#import <Foundation/Foundation.h>
#import <CommonCrypto/CommonDigest.h>
#include <fcntl.h>
#include <errno.h>
#include <limits.h>
#include <sys/stat.h>
#include <unistd.h>

static NSString *hexDigest(const unsigned char *bytes, NSUInteger length) {
    NSMutableString *value = [NSMutableString stringWithCapacity:length * 2];
    for (NSUInteger index = 0; index < length; index++) [value appendFormat:@"%02x", bytes[index]];
    return value;
}

static NSString *fileDigest(NSString *path, NSNumber *expectedSize) {
    int descriptor = open(path.fileSystemRepresentation, O_RDONLY | O_NOFOLLOW | O_CLOEXEC);
    if (descriptor < 0) return nil;
    struct stat status;
    if (fstat(descriptor, &status) != 0 || !S_ISREG(status.st_mode) ||
        status.st_size != expectedSize.longLongValue || status.st_size > 512LL * 1024 * 1024) {
        close(descriptor); return nil;
    }
    CC_SHA256_CTX context;
    CC_SHA256_Init(&context);
    unsigned char buffer[64 * 1024];
    ssize_t count;
    while ((count = read(descriptor, buffer, sizeof(buffer))) > 0) CC_SHA256_Update(&context, buffer, (CC_LONG)count);
    close(descriptor);
    if (count != 0) return nil;
    unsigned char digest[CC_SHA256_DIGEST_LENGTH];
    CC_SHA256_Final(digest, &context);
    return hexDigest(digest, sizeof(digest));
}

static NSString *canonicalRealPath(NSString *path) {
    char resolved[PATH_MAX];
    return realpath(path.fileSystemRepresentation, resolved) ?
        [[NSFileManager defaultManager] stringWithFileSystemRepresentation:resolved length:strlen(resolved)] : nil;
}

static BOOL exactKeys(NSDictionary *value, NSArray<NSString *> *keys) {
    return [[NSSet setWithArray:value.allKeys] isEqualToSet:[NSSet setWithArray:keys]];
}

static NSString *lexicalPath(NSString *path) {
    if (![path isKindOfClass:NSString.class] || !path.isAbsolutePath) return nil;
    NSMutableArray<NSString *> *parts = [NSMutableArray array];
    for (NSString *part in [path componentsSeparatedByString:@"/"]) {
        if (part.length == 0 || [part isEqualToString:@"."]) continue;
        if ([part isEqualToString:@".."]) {
            // POSIX absolute paths and Node path.resolve clamp excess parent
            // components at filesystem root rather than becoming invalid.
            if (parts.count > 0) [parts removeLastObject];
        } else [parts addObject:part];
    }
    return [@"/" stringByAppendingString:[parts componentsJoinedByString:@"/"]];
}

static BOOL verifyDependencies(NSArray *dependencies) {
    if (![dependencies isKindOfClass:NSArray.class] || dependencies.count > 512) return NO;
    NSMutableSet<NSString *> *paths = [NSMutableSet setWithCapacity:dependencies.count];
    unsigned long long total = 0;
    for (NSDictionary *binding in dependencies) {
        if (![binding isKindOfClass:NSDictionary.class] || !exactKeys(binding,
            @[@"logicalPath", @"realPath", @"sha256", @"size"])) return NO;
        NSString *logical = binding[@"logicalPath"], *expectedReal = binding[@"realPath"];
        NSString *digest = binding[@"sha256"];
        NSNumber *size = binding[@"size"];
        if (![logical isKindOfClass:NSString.class] || !logical.isAbsolutePath ||
            ![expectedReal isKindOfClass:NSString.class] || !expectedReal.isAbsolutePath ||
            ![digest isKindOfClass:NSString.class] || digest.length != 64 ||
            ![size isKindOfClass:NSNumber.class] || [paths containsObject:logical] ||
            ![canonicalRealPath(logical) isEqualToString:expectedReal]) return NO;
        [paths addObject:logical];
        if (size.unsignedLongLongValue > 512ULL * 1024 * 1024 ||
            total + size.unsignedLongLongValue > 2ULL * 1024 * 1024 * 1024) return NO;
        total += size.unsignedLongLongValue;
        if (![[fileDigest(expectedReal, size) lowercaseString] isEqualToString:digest]) return NO;
    }
    return YES;
}

static BOOL verifyMissingDependencies(NSArray *paths) {
    if (![paths isKindOfClass:NSArray.class] || paths.count > 512) return NO;
    NSMutableSet<NSString *> *seen = [NSMutableSet setWithCapacity:paths.count];
    for (NSString *path in paths) {
        if (![path isKindOfClass:NSString.class] || !path.isAbsolutePath ||
            [seen containsObject:path]) return NO;
        [seen addObject:path];
        struct stat status;
        errno = 0;
        if (lstat(path.fileSystemRepresentation, &status) == 0 || errno != ENOENT) return NO;
    }
    return YES;
}

static BOOL verifyExecutable(NSDictionary *binding) {
    if (![binding isKindOfClass:NSDictionary.class] || !exactKeys(binding,
        @[@"logicalPath", @"realPath", @"links", @"dependencies", @"missingDependencies",
          @"sha256", @"size"])) return NO;
    NSString *logical = binding[@"logicalPath"], *expectedReal = binding[@"realPath"];
    NSArray *links = binding[@"links"];
    NSNumber *size = binding[@"size"];
    NSString *digest = binding[@"sha256"];
    NSArray *dependencies = binding[@"dependencies"];
    NSArray *missingDependencies = binding[@"missingDependencies"];
    if (![logical isKindOfClass:NSString.class] || !logical.isAbsolutePath ||
        ![expectedReal isKindOfClass:NSString.class] || !expectedReal.isAbsolutePath ||
        ![links isKindOfClass:NSArray.class] || ![size isKindOfClass:NSNumber.class] ||
        ![digest isKindOfClass:NSString.class] || digest.length != 64) return NO;
    NSString *cursor = lexicalPath(logical);
    for (NSDictionary *link in links) {
        if (![link isKindOfClass:NSDictionary.class] || !exactKeys(link, @[@"path", @"target"]) ||
            ![cursor isEqualToString:link[@"path"]]) return NO;
        struct stat status;
        if (lstat(cursor.fileSystemRepresentation, &status) != 0 || !S_ISLNK(status.st_mode)) return NO;
        char target[PATH_MAX];
        ssize_t length = readlink(cursor.fileSystemRepresentation, target, sizeof(target));
        if (length < 0 || length >= (ssize_t)sizeof(target)) return NO;
        NSString *actual = [[NSString alloc] initWithBytes:target length:(NSUInteger)length encoding:NSUTF8StringEncoding];
        if (!actual || ![actual isEqualToString:link[@"target"]]) return NO;
        cursor = lexicalPath([actual hasPrefix:@"/"] ? actual :
            [cursor.stringByDeletingLastPathComponent stringByAppendingPathComponent:actual]);
    }
    if (![canonicalRealPath(logical) isEqualToString:expectedReal] ||
        ![cursor isEqualToString:expectedReal]) return NO;
    return [[fileDigest(expectedReal, size) lowercaseString] isEqualToString:digest] &&
        verifyDependencies(dependencies) && verifyMissingDependencies(missingDependencies);
}

static NSString *bundledPath(NSString *contents, NSString *relative) {
    if (!contents || ![relative isKindOfClass:NSString.class] ||
        (![relative hasPrefix:@"Frameworks/"] && ![relative isEqualToString:@"MacOS/node"]) ||
        [relative containsString:@".."] || [relative containsString:@"//"] ||
        [relative hasSuffix:@"/"]) return nil;
    NSString *path = [contents stringByAppendingPathComponent:relative];
    return [canonicalRealPath(path) isEqualToString:path] ? path : nil;
}

static BOOL verifyBundledRuntime(NSDictionary *runtime, NSString *configuration) {
    if (!exactKeys(runtime, @[@"format", @"nodeExecutable", @"nodeSha256", @"nodeBinding"]) ||
        ![runtime[@"nodeExecutable"] isEqualToString:@"MacOS/node"]) return NO;
    NSDictionary *binding = runtime[@"nodeBinding"];
    if (![binding isKindOfClass:NSDictionary.class] ||
        !exactKeys(binding, @[@"sha256", @"size", @"dependencies"]) ||
        ![binding[@"sha256"] isKindOfClass:NSString.class] ||
        [binding[@"sha256"] length] != 64 ||
        ![binding[@"size"] isKindOfClass:NSNumber.class] ||
        [binding[@"size"] longLongValue] <= 0 ||
        ![binding[@"sha256"] isEqualToString:runtime[@"nodeSha256"]]) return NO;
    NSString *contents = canonicalRealPath([configuration.stringByDeletingLastPathComponent
        stringByDeletingLastPathComponent]);
    NSString *node = bundledPath(contents, @"MacOS/node");
    if (!node || ![[fileDigest(node, binding[@"size"]) lowercaseString]
        isEqualToString:binding[@"sha256"]]) return NO;
    NSArray *dependencies = binding[@"dependencies"];
    if (![dependencies isKindOfClass:NSArray.class] || dependencies.count == 0 ||
        dependencies.count > 512) return NO;
    NSMutableSet *seen = [NSMutableSet set];
    unsigned long long total = 0;
    for (NSDictionary *dependency in dependencies) {
        if (![dependency isKindOfClass:NSDictionary.class] ||
            !exactKeys(dependency, @[@"path", @"sha256", @"size"])) return NO;
        NSString *relative = dependency[@"path"];
        NSString *path = bundledPath(contents, relative);
        NSNumber *size = dependency[@"size"];
        if (!path || ![relative hasPrefix:@"Frameworks/"] ||
            [relative substringFromIndex:@"Frameworks/".length].length == 0 ||
            [[relative substringFromIndex:@"Frameworks/".length] containsString:@"/"] ||
            [seen containsObject:relative] ||
            ![dependency[@"sha256"] isKindOfClass:NSString.class] ||
            [dependency[@"sha256"] length] != 64 || ![size isKindOfClass:NSNumber.class] ||
            size.longLongValue <= 0 ||
            size.unsignedLongLongValue > 512ULL * 1024 * 1024 ||
            total + size.unsignedLongLongValue > 2ULL * 1024 * 1024 * 1024 ||
            ![[fileDigest(path, size) lowercaseString] isEqualToString:dependency[@"sha256"]]) return NO;
        total += size.unsignedLongLongValue;
        [seen addObject:relative];
    }
    return YES;
}

static BOOL verifyRuntime(NSString *configuration) {
    NSData *bytes = [NSData dataWithContentsOfFile:configuration options:NSDataReadingMappedIfSafe error:nil];
    NSDictionary *runtime = bytes ? [NSJSONSerialization JSONObjectWithData:bytes options:0 error:nil] : nil;
    if (![runtime isKindOfClass:NSDictionary.class]) return NO;
    if ([runtime[@"format"] isEqualToString:@"nir-local-wallet-runtime-v3"]) {
        return verifyBundledRuntime(runtime, configuration);
    }
    return
        exactKeys(runtime, @[@"format", @"nodeExecutable", @"nodeSha256", @"nodeBinding"]) &&
        [runtime[@"format"] isEqualToString:@"nir-local-wallet-runtime-v2"] &&
        [runtime[@"nodeExecutable"] isKindOfClass:NSString.class] &&
        [runtime[@"nodeSha256"] isKindOfClass:NSString.class] &&
        [runtime[@"nodeBinding"] isKindOfClass:NSDictionary.class] &&
        [runtime[@"nodeExecutable"] isEqualToString:runtime[@"nodeBinding"][@"logicalPath"]] &&
        [runtime[@"nodeSha256"] isEqualToString:runtime[@"nodeBinding"][@"sha256"]] &&
        verifyExecutable(runtime[@"nodeBinding"]);
}

int main(int argc, const char *argv[]) {
    @autoreleasepool {
        if (argc != 2 || !verifyRuntime(@(argv[1]))) {
            fputs("wallet runtime binding verification failed\n", stderr);
            return 1;
        }
        return 0;
    }
}
